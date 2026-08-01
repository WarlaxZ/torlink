# Subtitles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match sibling subtitle files to the video being played and attach them in both front ends, and report embedded subtitle tracks that ffprobe already sees but currently discards.

**Architecture:** Two dependency-free modules in `src/util/` hold every decision (which subtitle belongs to which video; SRT→WebVTT text conversion), so the TUI and the browser bundle share one implementation. The server gains a `.vtt` representation on the existing stream handle — inheriting its session, capability, readiness and bounds guards — and the `.m3u` gains a VLC `input-slave` line when a subtitle matches. `parseFfprobe` stops discarding subtitle rows; nothing extracts them.

**Tech Stack:** TypeScript, Node 22+, vitest, Ink (TUI), tsup (browser bundle), ffprobe (already a runtime dependency).

**Spec:** `docs/superpowers/specs/2026-08-01-subtitles-design.md`

## Global Constraints

- **A feature ships in both front ends.** `src/ui` (terminal) and `src/web` (browser) are two front ends over one core. See `CLAUDE.md`.
- **`src/web` must not import from `src/ui`**, and `src/core` must not import from either. Lint enforces this. Share by moving code down into `src/util/`.
- **`src/util/subtitleFiles.ts` and `src/util/srtToVtt.ts` must stay dependency-free** — no `node:*`, no transitive import that reaches one. They are bundled for the browser. `npm run build` is the enforcement.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` anywhere in `src/web/static/`.** Every node is `createElement` + `textContent`. Subtitle filenames come from whoever made the torrent.
- **`app.ts` and `player.ts` are DOM wiring only.** A conditional deciding *what to show* or *what to send* belongs in a pure module. Caught in review twice.
- **Test fixtures name invented titles, never real ones.** Use the cast in `CLAUDE.md`: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **Before saying it's done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it.
- **Conventional Commits**, and fail soft: no subtitle match must leave every existing behaviour byte-identical.

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `src/util/subtitleFiles.ts` | Which subtitle files exist, which video each belongs to, what language it is. Pure, browser-safe. |
| `src/util/subtitleFiles.test.ts` | Tests for the above. |
| `src/util/srtToVtt.ts` | SRT text → WebVTT text. Pure, browser-safe. |
| `src/util/srtToVtt.test.ts` | Tests for the above. |
| `src/web/static/subtitleModel.ts` | Which `<track>` elements the player page should build, and the fallback card's embedded-track line. Pure, tested. |
| `src/web/static/subtitleModel.test.ts` | Tests for the above. |
| `src/util/subtitleFlags.ts` | Player command → subtitle CLI flag. Pure, Node-side only but no imports. |
| `src/util/subtitleFlags.test.ts` | Tests for the above. |

**Modified**

| File | Change |
| --- | --- |
| `src/util/playability.ts` | `MediaFacts` gains `subtitles: EmbeddedSubtitle[]`; `classifyFromName` returns `[]`. |
| `src/core/probe.ts` | `ffprobeArgs` requests language/title tags; `parseFfprobe` keeps subtitle rows. |
| `src/core/probe.test.ts` | The "ignores subtitle streams" test inverts. |
| `src/web/wire.ts` | `StreamInfoResponse` gains `subtitles`; new `SubtitleFile` type. |
| `src/web/stream.ts` | `.vtt` representation; `.m3u` input-slave line; `.info` reports subtitles. |
| `src/web/static/playerModel.ts` | `subtitlePath()` builder. |
| `src/web/static/player.ts` | Build `<track>` elements; fallback card shows embedded languages. |
| `src/util/player.ts` | `launchPlayer` takes an optional subtitle URL. |
| `src/ui/App.tsx` | Pass the matched subtitle URL through to launch. |
| `src/ui/components/StreamFilePrompt.tsx` | Mark rows that have subtitles. |
| `README.md` | Replace "No subtitles, no scrubber." |

---

### Task 1: Subtitle file matching

**Files:**
- Create: `src/util/subtitleFiles.ts`
- Test: `src/util/subtitleFiles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isSubtitleFilename(filename: string): boolean`
  - `isBrowserRenderable(filename: string): boolean` — true for `srt`/`vtt` only
  - `subtitleLanguage(filename: string): { code: string; label: string }` — `code` is a 2-letter BCP-47 tag or `""`; `label` is human text like `"English"`, `"English (forced)"`, or the bare basename when no language is detected
  - `subtitlesFor<T extends NamedFile>(video: T, files: readonly T[]): T[]`
  - `preferredSubtitle<T extends NamedFile>(matches: readonly T[]): T | null`
  - Re-uses `NamedFile` from `./videoFiles`.

- [ ] **Step 1: Write the failing test**

Create `src/util/subtitleFiles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isBrowserRenderable,
  isSubtitleFilename,
  preferredSubtitle,
  subtitleLanguage,
  subtitlesFor,
} from "./subtitleFiles";

const f = (filename: string): { filename: string } => ({ filename });

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

  it("prefers rule 1 over rule 2 rather than merging them", () => {
    // A pack with both layouts: the exact-basename match is the confident one,
    // and returning both would put a duplicate language in the track menu.
    const video = f("Kepler.S02E04.1080p.WEB-DL.mkv");
    const exact = f("Kepler.S02E04.1080p.WEB-DL.eng.srt");
    const folder = f("Subs/Kepler.S02E04/2_English.srt");
    expect(subtitlesFor(video, [video, exact, folder])).toEqual([exact]);
  });

  it("returns nothing when the torrent has no subtitles at all", () => {
    // The season pack that prompted this feature: ten episodes, nothing else.
    const video = f("Harrowgate.S03.1080p.WEB-DL.mkv");
    expect(subtitlesFor(video, [video])).toEqual([]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/subtitleFiles.test.ts`
Expected: FAIL — `Cannot find module './subtitleFiles'`.

- [ ] **Step 3: Write the implementation**

Create `src/util/subtitleFiles.ts`:

```ts
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
const LANGUAGES: { code: string; label: string; tokens: string[] }[] = [
  { code: "en", label: "English", tokens: ["en", "eng", "english"] },
  { code: "es", label: "Spanish", tokens: ["es", "spa", "esp", "spanish", "castellano", "latino"] },
  { code: "pt", label: "Portuguese", tokens: ["pt", "por", "portuguese", "brazilian"] },
  { code: "fr", label: "French", tokens: ["fr", "fre", "fra", "french"] },
  { code: "de", label: "German", tokens: ["de", "ger", "deu", "german"] },
  { code: "it", label: "Italian", tokens: ["it", "ita", "italian"] },
  { code: "nl", label: "Dutch", tokens: ["nl", "dut", "nld", "dutch"] },
  { code: "pl", label: "Polish", tokens: ["pl", "pol", "polish"] },
  { code: "ru", label: "Russian", tokens: ["ru", "rus", "russian"] },
  { code: "ja", label: "Japanese", tokens: ["ja", "jpn", "japanese"] },
  { code: "ko", label: "Korean", tokens: ["ko", "kor", "korean"] },
  { code: "zh", label: "Chinese", tokens: ["zh", "chi", "zho", "chinese"] },
  { code: "ar", label: "Arabic", tokens: ["ar", "ara", "arabic"] },
  { code: "sv", label: "Swedish", tokens: ["sv", "swe", "swedish"] },
  { code: "da", label: "Danish", tokens: ["da", "dan", "danish"] },
  { code: "no", label: "Norwegian", tokens: ["no", "nor", "norwegian"] },
  { code: "fi", label: "Finnish", tokens: ["fi", "fin", "finnish"] },
  { code: "tr", label: "Turkish", tokens: ["tr", "tur", "turkish"] },
];

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
 * before the extension ("…​.eng.srt"), and both are common.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/util/subtitleFiles.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/util/subtitleFiles.ts src/util/subtitleFiles.test.ts
git commit -m "feat(util): match sibling subtitle files to a video"
```

---

### Task 2: SRT to WebVTT conversion

**Files:**
- Create: `src/util/srtToVtt.ts`
- Test: `src/util/srtToVtt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `srtToVtt(text: string): string`
  - `decodeSubtitle(bytes: Uint8Array): string` — UTF-8 with a latin1 fallback

- [ ] **Step 1: Write the failing test**

Create `src/util/srtToVtt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeSubtitle, srtToVtt } from "./srtToVtt";

describe("srtToVtt", () => {
  it("adds the WEBVTT header", () => {
    expect(srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHello\n")).toMatch(/^WEBVTT\n/);
  });

  it("converts comma decimals to dots in timestamps", () => {
    // The only difference between the two formats that actually stops a
    // browser parsing the file.
    const out = srtToVtt("1\n00:01:02,345 --> 00:01:04,567\nHello\n");
    expect(out).toContain("00:01:02.345 --> 00:01:04.567");
    expect(out).not.toContain(",345");
  });

  it("drops the numeric cue index lines", () => {
    const out = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n");
    expect(out).not.toMatch(/^\s*1\s*$/m);
    expect(out).not.toMatch(/^\s*2\s*$/m);
    expect(out).toContain("First");
    expect(out).toContain("Second");
  });

  it("keeps a numeric line that is dialogue, not an index", () => {
    // A cue whose text is "1998" must survive. Only a bare number IMMEDIATELY
    // followed by a timestamp line is an index.
    const out = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\n1998\n");
    expect(out).toContain("1998");
  });

  it("strips a UTF-8 BOM", () => {
    // A BOM before WEBVTT makes the browser reject the whole file.
    const out = srtToVtt("\uFEFF1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    expect(out.startsWith("WEBVTT")).toBe(true);
  });

  it("normalises CRLF line endings", () => {
    const out = srtToVtt("1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n");
    expect(out).not.toContain("\r");
    expect(out).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("passes an existing WebVTT file through unchanged apart from newlines", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n";
    expect(srtToVtt(vtt)).toBe(vtt);
  });

  it("does not double the header on a WebVTT file with a BOM", () => {
    const out = srtToVtt("\uFEFFWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n");
    expect(out.match(/WEBVTT/g)).toHaveLength(1);
  });

  it("keeps hour-less timestamps working", () => {
    // Some encoders write MM:SS,mmm. WebVTT allows it, so leave it alone apart
    // from the separator.
    expect(srtToVtt("1\n01:02,345 --> 01:04,567\nHi\n")).toContain("01:02.345 --> 01:04.567");
  });

  it("returns a bare header for empty input rather than an empty file", () => {
    expect(srtToVtt("")).toBe("WEBVTT\n");
  });
});

describe("decodeSubtitle", () => {
  it("decodes UTF-8", () => {
    const bytes = new TextEncoder().encode("Grüße");
    expect(decodeSubtitle(bytes)).toBe("Grüße");
  });

  it("falls back to latin1 for bytes that are not valid UTF-8", () => {
    // .srt files are frequently Windows-1252. Decoding those as UTF-8 yields
    // U+FFFD replacement characters, and a mojibake subtitle is worse than
    // none — so an invalid sequence means "this was never UTF-8".
    const latin1 = new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]); // "Grüße" in latin1
    expect(decodeSubtitle(latin1)).toBe("Grüße");
  });

  it("does not mistake valid UTF-8 multibyte text for latin1", () => {
    const bytes = new TextEncoder().encode("日本語");
    expect(decodeSubtitle(bytes)).toBe("日本語");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/srtToVtt.test.ts`
Expected: FAIL — `Cannot find module './srtToVtt'`.

- [ ] **Step 3: Write the implementation**

Create `src/util/srtToVtt.ts`:

```ts
/**
 * SRT text to WebVTT text.
 *
 * `<track>` accepts WebVTT and nothing else, so this is what makes a sibling
 * .srt showable in a browser. The two formats are near-identical: the
 * differences that matter are a required header, `.` instead of `,` as the
 * millisecond separator, and cue index lines that WebVTT does not use.
 *
 * DEPENDENCY-FREE, like ./subtitleFiles.ts and for the same reason — it is
 * bundled for the browser as well as run in Node. No `node:*`, and note that
 * `Buffer` is a node global: decodeSubtitle uses TextDecoder, which both have.
 */

const TIMESTAMP_RE = /^(.*\d)[,.](\d{1,3})(\s*-->\s*)(.*\d)[,.](\d{1,3})(.*)$/;

/** True for a line that is only digits — a candidate SRT cue index. */
function isIndexLine(line: string): boolean {
  return /^\d+$/.test(line.trim());
}

function isTimestampLine(line: string): boolean {
  return line.includes("-->");
}

/**
 * Convert, or pass through if it is already WebVTT.
 *
 * A cue index is dropped only when the NEXT line is a timestamp. A bare number
 * anywhere else is dialogue — a cue whose text is "1998" is not an index, and
 * dropping it would silently delete a subtitle line.
 */
export function srtToVtt(text: string): string {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT/.test(clean)) return clean;
  if (clean.trim() === "") return "WEBVTT\n";

  const lines = clean.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isIndexLine(line) && isTimestampLine(lines[i + 1] ?? "")) continue;
    const m = TIMESTAMP_RE.exec(line);
    out.push(m ? `${m[1]}.${m[2]}${m[3]}${m[4]}.${m[5]}${m[6]}` : line);
  }
  return `WEBVTT\n\n${out.join("\n").replace(/^\n+/, "")}`;
}

/**
 * Decode subtitle bytes to text.
 *
 * UTF-8 first, strictly: `fatal: true` makes an invalid sequence throw rather
 * than produce U+FFFD. That distinction is the whole point — .srt files are
 * frequently Windows-1252, and a subtitle full of replacement characters is
 * worse than one decoded by the right fallback. latin1 cannot fail, so this
 * always returns something.
 */
export function decodeSubtitle(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/util/srtToVtt.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/util/srtToVtt.ts src/util/srtToVtt.test.ts
git commit -m "feat(util): convert SRT text to WebVTT"
```

---

### Task 3: Report embedded subtitle tracks from ffprobe

**Files:**
- Modify: `src/util/playability.ts` (the `MediaFacts` interface, and `classifyFromName`)
- Modify: `src/core/probe.ts:29-43` (`ffprobeArgs`), `src/core/probe.ts:45-48` (`ProbeStream`), `src/core/probe.ts:71-103` (`parseFfprobe`)
- Modify: `src/core/probe.test.ts:78` (the test that inverts)
- Test: `src/core/probe.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `EmbeddedSubtitle` in `src/util/playability.ts`: `{ language: string; label: string }` where `language` is ffprobe's raw tag (e.g. `"eng"`, `""` when untagged) and `label` is its `title` tag or `""`.
  - `MediaFacts.subtitles: EmbeddedSubtitle[]`.

- [ ] **Step 1: Write the failing test**

In `src/core/probe.test.ts`, REPLACE the existing `it("ignores subtitle and attachment streams", …)` block (starts at line 78) with:

```ts
  it("reports subtitle streams instead of discarding them", () => {
    // This test used to assert the opposite. Subtitle rows were dropped, so a
    // file with three muxed tracks looked identical to one with none, and the
    // player page could not tell the user they existed. Attachment streams
    // (fonts, cover art) are still ignored — they are not tracks.
    const facts = parseFfprobe(
      output("mov,mp4", [
        { codec_type: "video", codec_name: "hevc" },
        { codec_type: "audio", codec_name: "eac3" },
        { codec_type: "subtitle", codec_name: "mov_text", tags: { language: "spa" } },
        { codec_type: "subtitle", codec_name: "mov_text", tags: { language: "eng" } },
        { codec_type: "attachment", codec_name: "ttf" },
      ]),
      "mp4",
    );
    expect(facts?.subtitles).toEqual([
      { language: "spa", label: "" },
      { language: "eng", label: "" },
    ]);
  });

  it("keeps a subtitle stream's title tag as its label", () => {
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng", title: "SDH" } },
      ]),
      "mkv",
    );
    expect(facts?.subtitles).toEqual([{ language: "eng", label: "SDH" }]);
  });

  it("reports an untagged subtitle stream with an empty language", () => {
    // Present but unnamed is still information: the player can say "1 subtitle
    // track" rather than nothing.
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "subtitle", codec_name: "subrip" },
      ]),
      "mkv",
    );
    expect(facts?.subtitles).toEqual([{ language: "", label: "" }]);
  });

  it("reports an empty subtitle list for a file with none", () => {
    const facts = parseFfprobe(
      output("matroska,webm", [{ codec_type: "video", codec_name: "h264" }]),
      "mkv",
    );
    expect(facts?.subtitles).toEqual([]);
  });

  it("asks ffprobe for the language and title tags", () => {
    // Without this the tags are absent from the JSON and every track reports an
    // empty language — the failure would look like "no subtitles have names".
    const entries = ffprobeArgs("http://example.test/a.mkv")[
      ffprobeArgs("http://example.test/a.mkv").indexOf("-show_entries") + 1
    ];
    expect(entries).toContain("stream_tags=language,title");
  });
```

Check the existing `output(...)` helper at the top of that file: if it does not accept a `tags` field on a stream, widen its parameter type to include `tags?: { language?: string; title?: string }`. Add `ffprobeArgs` to the file's import from `./probe` if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/probe.test.ts`
Expected: FAIL — `facts.subtitles` is undefined, and the `-show_entries` assertion fails.

- [ ] **Step 3: Write the implementation**

In `src/util/playability.ts`, add above `MediaFacts`:

```ts
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
```

Add to the `MediaFacts` interface, after `source`:

```ts
  /**
   * Subtitle tracks muxed into the file. Always empty from `classifyFromName`:
   * a release name cannot know what is inside the container.
   */
  subtitles: EmbeddedSubtitle[];
```

In `classifyFromName`, add `subtitles: []` to the returned object.

In `src/core/probe.ts`, change `ffprobeArgs`'s `-show_entries` value from:

```ts
    "format=format_name:stream=codec_type,codec_name",
```

to:

```ts
    "format=format_name:stream=codec_type,codec_name:stream_tags=language,title",
```

Widen `ProbeStream`:

```ts
interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  tags?: { language?: string; title?: string };
}
```

In `parseFfprobe`, before the `return`, add:

```ts
  // Subtitle streams, kept. An earlier version discarded them here, which made
  // a file with three muxed tracks indistinguishable from one with none.
  // Attachments (fonts, cover art) are still dropped — they are not tracks.
  const subtitles = streams
    .filter((s) => s.codec_type === "subtitle")
    .map((s) => ({ language: s.tags?.language ?? "", label: s.tags?.title ?? "" }));
```

and add `subtitles,` to the returned object.

Update the `MediaFacts` import in `src/core/probe.ts:12` to also import `EmbeddedSubtitle` only if you reference the type by name; the `.map` above infers it, so no import change is needed.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run src/core/probe.test.ts && npm run typecheck`
Expected: probe tests PASS. Typecheck will FAIL in any file constructing a `MediaFacts` literal without `subtitles` — fix each by adding `subtitles: []`. Check `src/util/playability.test.ts`, `src/web/stream.test.ts`, `src/core/streamRoute.test.ts` and `src/web/static/playerModel.test.ts`.

- [ ] **Step 5: Run everything and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/util/playability.ts src/core/probe.ts src/core/probe.test.ts
git add -u
git commit -m "feat(probe): report embedded subtitle tracks instead of discarding them"
```

---

### Task 4: The `.vtt` representation and the `.m3u` input-slave line

**Files:**
- Modify: `src/web/stream.ts` — `StreamRep` (line 140), `splitRepresentation` (line 157), the playlist branch (line 431), the `.info` branch (line 341)
- Modify: `src/web/wire.ts` — `StreamInfoResponse` (line 126)
- Test: `src/web/stream.test.ts`

**Interfaces:**
- Consumes: `isSubtitleFilename`, `isBrowserRenderable`, `subtitleLanguage`, `subtitlesFor`, `preferredSubtitle` (Task 1); `decodeSubtitle`, `srtToVtt` (Task 2); `EmbeddedSubtitle` (Task 3).
- Produces:
  - `StreamRep` gains `"subtitle"`.
  - `SubtitleFile` in `src/web/wire.ts`: `{ index: number; filename: string; language: string; label: string; renderable: boolean }`.
  - `StreamInfoResponse.subtitles: { embedded: EmbeddedSubtitle[]; files: SubtitleFile[] }`.
  - `MAX_SUBTITLE_BYTES = 4 * 1024 * 1024` exported from `src/web/stream.ts`.
  - `StreamDeps.fetchSubtitle?: (url: string, allowed: readonly string[]) => Promise<Uint8Array | null>`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/stream.test.ts`. Follow the file's existing helpers for building `deps`, a ready session and a capability — read the top of the file and reuse them rather than inventing new ones.

```ts
describe("the .vtt representation", () => {
  it("serves a matched subtitle as WebVTT", async () => {
    const { deps, sid, cap } = readySession([
      { filename: "Kepler.S02E04.1080p.WEB-DL.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: "Kepler.S02E04.1080p.WEB-DL.eng.srt", url: "http://up.test/s", bytes: 40 },
    ], { body: "1\n00:00:01,000 --> 00:00:02,000\nHello\n" });
    const res = await request(deps, `/stream/${sid}/1.vtt?k=${cap}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/vtt; charset=utf-8");
    expect(res.body).toMatch(/^WEBVTT/);
    expect(res.body).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("refuses an index that is not a subtitle file", async () => {
    // THE GUARD THIS ROUTE NEEDS MOST. Without it, .vtt is a general-purpose
    // "pull this whole file into memory and call it text" route aimed at a
    // 12 GB video.
    const { deps, sid, cap } = readySession([
      { filename: "Kepler.S02E04.1080p.WEB-DL.mkv", url: "http://up.test/v", bytes: 9e9 },
    ]);
    const res = await request(deps, `/stream/${sid}/0.vtt?k=${cap}`);
    expect(res.status).toBe(404);
  });

  it("requires the capability, like every other representation", async () => {
    const { deps, sid } = readySession([
      { filename: "Kestrel.2010.1080p.BluRay.x264.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: "Kestrel.2010.1080p.BluRay.x264.eng.srt", url: "http://up.test/s", bytes: 40 },
    ]);
    const res = await request(deps, `/stream/${sid}/1.vtt`);
    expect(res.status).toBe(401);
  });

  it("refuses a subtitle larger than the cap", async () => {
    const { deps, sid, cap } = readySession([
      { filename: "Kestrel.2010.1080p.BluRay.x264.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: "Kestrel.2010.1080p.BluRay.x264.eng.srt", url: "http://up.test/s", bytes: 9e8 },
    ]);
    const res = await request(deps, `/stream/${sid}/1.vtt?k=${cap}`);
    expect(res.status).toBe(413);
  });

  it("stops reading a body that exceeds the cap even when file.bytes lied", async () => {
    // file.bytes is what upstream CLAIMED. This is what it actually sent.
    const { deps, sid, cap } = readySession([
      { filename: "Kestrel.2010.1080p.BluRay.x264.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: "Kestrel.2010.1080p.BluRay.x264.eng.srt", url: "http://up.test/s", bytes: 40 },
    ], { body: "x".repeat(MAX_SUBTITLE_BYTES + 1) });
    const res = await request(deps, `/stream/${sid}/1.vtt?k=${cap}`);
    expect(res.status).toBe(502);
  });

  it("answers 502 when the upstream subtitle fetch fails", async () => {
    const { deps, sid, cap } = readySession([
      { filename: "Kestrel.2010.1080p.BluRay.x264.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: "Kestrel.2010.1080p.BluRay.x264.eng.srt", url: "http://up.test/s", bytes: 40 },
    ], { fail: true });
    const res = await request(deps, `/stream/${sid}/1.vtt?k=${cap}`);
    expect(res.status).toBe(502);
  });
});

describe("the .m3u with a matched subtitle", () => {
  it("adds an input-slave line pointing at the .vtt handle", async () => {
    const { deps, sid, cap } = readySession([
      { filename: "Kepler.S02E04.1080p.WEB-DL.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: "Kepler.S02E04.1080p.WEB-DL.eng.srt", url: "http://up.test/s", bytes: 40 },
    ]);
    const res = await request(deps, `/stream/${sid}/0.m3u?k=${cap}`, { host: "box.test:9161" });
    expect(res.body).toBe(
      `#EXTM3U\n` +
        `#EXTVLCOPT:input-slave=http://box.test:9161/stream/${sid}/1.vtt?k=${cap}\n` +
        `http://box.test:9161/stream/${sid}/0?k=${cap}\n`,
    );
  });

  it("is byte-identical to the old single-URL form when nothing matches", async () => {
    // Fail-soft, and the reason this is asserted on the exact bytes: every
    // player in the world already parses today's playlist, and a feature that
    // has nothing to add must add nothing.
    const { deps, sid, cap } = readySession([
      { filename: "Harrowgate.S03.1080p.WEB-DL.mkv", url: "http://up.test/v", bytes: 900 },
    ]);
    const res = await request(deps, `/stream/${sid}/0.m3u?k=${cap}`, { host: "box.test:9161" });
    expect(res.body).toBe(`http://box.test:9161/stream/${sid}/0?k=${cap}\n`);
  });

  it("puts no torrent-supplied text in the playlist body", async () => {
    // The constraint the original one-bare-URL form existed to guarantee. Both
    // URLs are built from streamHandle and the capability, so a filename with a
    // newline or a quote in it cannot reach a file another application parses.
    const { deps, sid, cap } = readySession([
      { filename: "Kepler.S02E04.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: 'Kepler.S02E04\n#EXTVLCOPT:evil="x".eng.srt', url: "http://up.test/s", bytes: 40 },
    ]);
    const res = await request(deps, `/stream/${sid}/0.m3u?k=${cap}`, { host: "box.test:9161" });
    expect(res.body).not.toContain("evil");
    expect(res.body.split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("prefers the English subtitle for the input-slave", async () => {
    const { deps, sid, cap } = readySession([
      { filename: "Kepler.S02E04.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: "Kepler.S02E04.spa.srt", url: "http://up.test/s1", bytes: 40 },
      { filename: "Kepler.S02E04.eng.srt", url: "http://up.test/s2", bytes: 40 },
    ]);
    const res = await request(deps, `/stream/${sid}/0.m3u?k=${cap}`, { host: "box.test:9161" });
    expect(res.body).toContain(`/stream/${sid}/2.vtt?k=${cap}`);
  });
});

describe("the .info subtitle report", () => {
  it("lists matched sibling files with language and renderability", async () => {
    const { deps, sid, cap } = readySession([
      { filename: "Kepler.S02E04.mkv", url: "http://up.test/v", bytes: 900 },
      { filename: "Kepler.S02E04.eng.srt", url: "http://up.test/s1", bytes: 40 },
      { filename: "Kepler.S02E04.spa.ass", url: "http://up.test/s2", bytes: 40 },
    ]);
    const res = await request(deps, `/stream/${sid}/0.info?k=${cap}`);
    const body = JSON.parse(res.body);
    expect(body.subtitles.files).toEqual([
      { index: 1, filename: "Kepler.S02E04.eng.srt", language: "en", label: "English", renderable: true },
      { index: 2, filename: "Kepler.S02E04.spa.ass", language: "es", label: "Spanish", renderable: false },
    ]);
  });

  it("reports embedded tracks from the probe", async () => {
    const { deps, sid, cap } = readySession(
      [{ filename: "Kepler.S02E04.mkv", url: "http://up.test/v", bytes: 900 }],
      {
        probe: {
          container: "mkv",
          videoCodec: "hevc",
          audioCodec: "eac3",
          source: "probe",
          subtitles: [{ language: "eng", label: "" }],
        },
      },
    );
    const res = await request(deps, `/stream/${sid}/0.info?k=${cap}`);
    expect(JSON.parse(res.body).subtitles.embedded).toEqual([{ language: "eng", label: "" }]);
  });
});
```

Extend the file's session/request helpers as needed so `readySession` accepts `{ body, fail, probe }` and `request` accepts a `host`. Keep them local to the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/stream.test.ts`
Expected: FAIL — `.vtt` falls through to the media branch, and `body.subtitles` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/web/wire.ts`, add before `StreamInfoResponse`:

```ts
/**
 * A subtitle file that ships alongside the video in the same torrent, as the
 * browser is allowed to see it.
 *
 * `index` addresses it on `/stream/:sid/:idx.vtt`, the same grammar as the
 * video's own handle. `renderable` is false for ass/ssa/sub: those are matched
 * and offered to external players, but `<track>` cannot show them.
 */
export interface SubtitleFile {
  index: number;
  filename: string;
  /** BCP-47 tag ("en"), or "" when the filename gave no language. */
  language: string;
  /** Human label for a track menu: "English", "English (forced)". */
  label: string;
  renderable: boolean;
}
```

Add to `StreamInfoResponse`:

```ts
  /**
   * What subtitles exist for this file. `embedded` is muxed inside it and is
   * reported only — nothing extracts it. `files` are siblings in the torrent,
   * fetchable as WebVTT from `/stream/:sid/:idx.vtt`.
   */
  subtitles: { embedded: EmbeddedSubtitle[]; files: SubtitleFile[] };
```

Import `EmbeddedSubtitle` alongside the existing `Blocker, MediaFacts` import at `src/web/wire.ts:36`.

In `src/web/stream.ts`:

Add the suffix constant next to `PLAYLIST_SUFFIX` and `INFO_SUFFIX`:

```ts
const SUBTITLE_SUFFIX = ".vtt";
```

Widen the type at line 140 and the splitter at line 157:

```ts
export type StreamRep = "media" | "playlist" | "info" | "subtitle";
```

```ts
  if (urlPath.endsWith(SUBTITLE_SUFFIX)) {
    return { path: urlPath.slice(0, -SUBTITLE_SUFFIX.length), rep: "subtitle" };
  }
```

Add near the other module constants:

```ts
/**
 * The most a subtitle may be. A two-hour SRT is tens of kilobytes; four MiB is
 * far past any real one. This route reads the whole body into memory to convert
 * it, so without a cap a caller could aim it at a video file — the extension
 * check below is the first guard against that and this is the second.
 */
export const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;
```

Add a helper above `handleStreamRequest`:

```ts
/**
 * The sibling subtitle files for one video, as the wire type.
 *
 * Server-side because only the server holds the whole file list with its
 * indexes — `toPublicSession` exposes them, but the `.info` response is where
 * the player page reads them from, and doing it here means the browser never
 * has to re-run the matcher.
 */
function subtitleFilesFor(session: StreamSession, index: number): SubtitleFile[] {
  const video = session.files[index];
  if (!video) return [];
  const withIndex = session.files.map((f, i) => ({ ...f, index: i }));
  return subtitlesFor(withIndex[index]!, withIndex).map((s) => {
    const { code, label } = subtitleLanguage(s.filename);
    return {
      index: s.index,
      filename: s.filename,
      language: code,
      label,
      renderable: isBrowserRenderable(s.filename),
    };
  });
}
```

In the `.info` branch, change the body construction to:

```ts
    const body: StreamInfoResponse = {
      facts,
      blockers: blockersFor(facts),
      hls,
      subtitles: {
        embedded: facts.subtitles,
        files: subtitleFilesFor(session, parsed.index),
      },
    };
```

Add the `subtitle` branch immediately after the `.info` branch and before the playlist branch:

```ts
  // The `.vtt`: a sibling subtitle file, converted for a <track>.
  //
  // Two guards this representation needs that the others do not. The extension
  // check keeps it from being a general-purpose "read a whole file into memory
  // and call it text" route aimed at a 12 GB video, and the size cap is the
  // second line of that same defence.
  if (rep === "subtitle") {
    if (!isSubtitleFilename(file.filename)) {
      writeJson(res, 404, { error: "not a subtitle" });
      return 404;
    }
    if (file.bytes > MAX_SUBTITLE_BYTES) {
      writeJson(res, 413, { error: "subtitle too large" });
      return 413;
    }
    const fetched = await deps.fetchSubtitle(file.url, backendProtocols(session));
    if (!fetched) {
      // Same status and the same silence about the URL as proxyUpstream: an
      // unrestricted link is a credential against the user's account.
      deps.log("stream: could not fetch subtitle upstream");
      writeJson(res, 502, { error: "bad upstream" });
      return 502;
    }
    const payload = Buffer.from(srtToVtt(decodeSubtitle(fetched)), "utf8");
    res.writeHead(200, {
      "Content-Type": "text/vtt; charset=utf-8",
      "Content-Length": String(payload.length),
      // Same reason as the playlist: the URL that produced this carries a
      // capability for a session that will be reaped.
      "Cache-Control": "no-store",
    });
    if (method !== "HEAD") res.end(payload);
    else res.end();
    return 200;
  }
```

**`fetchSubtitle` does not exist yet — add it, and do not reach for global `fetch`.** This module talks upstream through `node:http`/`node:https` (line 20-21), and `proxyUpstream` runs every URL through `resolveProxyTarget(target, allowedProtocols, MAX_PROXY_HOPS)` first. That check is not optional decoration: it is what stops a `file://` or redirect-to-anywhere upstream, and the `.vtt` route must not be the one path that skips it.

Add to `StreamDeps`:

```ts
  /**
   * Read a whole subtitle file from upstream, or null on any failure.
   *
   * Separate from the proxy because this one buffers rather than streams — a
   * subtitle has to be converted before a byte of it can be sent. Injectable so
   * the `.vtt` route is testable without a network; the default implementation
   * goes through the same `resolveProxyTarget` allowlist the proxy does, which
   * is the point of it being here rather than a bare `fetch`.
   */
  fetchSubtitle?: (url: string, allowed: readonly string[]) => Promise<Uint8Array | null>;
```

Implement the default next to `proxyUpstream`, reusing `resolveProxyTarget` and the `http`/`https` request the proxy already builds. Buffer up to `MAX_SUBTITLE_BYTES` and destroy the response if the body exceeds it — the `file.bytes` check above is what upstream *claimed*, and this is what it actually sent.

Also add a small helper for the protocol allowlist, so the `.vtt` branch matches whichever backend the session uses:

```ts
// The same split the media branch makes: a debrid link is https, a WebTorrent
// file is served from this machine over http.
function backendProtocols(session: StreamSession): readonly string[] {
  return session.backend === "debrid" ? HTTP_AND_HTTPS : HTTP_ONLY;
}
```

Read the media branch (around line 472-486) to confirm the exact constant names and the field that distinguishes the backends before writing this.

In the playlist branch, replace the body construction:

```ts
    const url = `${origin}${streamHandle(parsed.sid, parsed.index)}?k=${encodeURIComponent(k!)}`;
    // One bare URL when there is no subtitle — byte-identical to what every
    // player has parsed since this route existed, because a feature with
    // nothing to add must add nothing.
    //
    // With a match, an #EXTVLCOPT:input-slave line, which is how VLC takes a
    // side-loaded subtitle. Note what is still true: BOTH urls are built from
    // streamHandle and the re-encoded capability, so nothing derived from the
    // torrent's own text reaches a file another application parses. That was
    // the reason the original form was one bare URL and it has not changed.
    const subs = subtitleFilesFor(session, parsed.index);
    const preferred = preferredSubtitle(subs);
    const body = preferred
      ? `#EXTM3U\n#EXTVLCOPT:input-slave=${origin}${streamHandle(parsed.sid, preferred.index)}.vtt?k=${encodeURIComponent(k!)}\n${url}\n`
      : `${url}\n`;
```

Add the imports at the top of `src/web/stream.ts`:

```ts
import {
  isBrowserRenderable,
  isSubtitleFilename,
  preferredSubtitle,
  subtitleLanguage,
  subtitlesFor,
} from "../util/subtitleFiles";
import { decodeSubtitle, srtToVtt } from "../util/srtToVtt";
import type { SubtitleFile } from "./wire";
```

`preferredSubtitle` is generic over `NamedFile`, and `SubtitleFile` has a `filename`, so it accepts the mapped array directly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/web/stream.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/stream.ts src/web/wire.ts src/web/stream.test.ts
git commit -m "feat(web): serve sibling subtitles as WebVTT and side-load them in the .m3u"
```

---

### Task 5: The browser player's subtitle decisions

**Files:**
- Create: `src/web/static/subtitleModel.ts`
- Test: `src/web/static/subtitleModel.test.ts`
- Modify: `src/web/static/playerModel.ts` (add `subtitlePath`)

**Interfaces:**
- Consumes: `StreamInfoResponse`, `SubtitleFile` (Task 4); `PlayerTarget` from `playerModel.ts`.
- Produces:
  - `subtitlePath(target: PlayerTarget, index: number): string` in `playerModel.ts`
  - `TrackSpec = { src: string; srclang: string; label: string; default: boolean }`
  - `subtitleTracks(info: StreamInfoResponse | null, target: PlayerTarget): TrackSpec[]`
  - `embeddedNotice(info: StreamInfoResponse | null): string` — `""` when there is nothing to say

- [ ] **Step 1: Write the failing test**

Create `src/web/static/subtitleModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { embeddedNotice, subtitleTracks } from "./subtitleModel";
import type { PlayerTarget } from "./playerModel";
import type { StreamInfoResponse } from "../wire";

const target: PlayerTarget = { sid: "abc", index: 0, capability: "cap", filename: "Kepler.S02E04.mkv" };

const info = (over: Partial<StreamInfoResponse>): StreamInfoResponse => ({
  facts: { container: "mkv", videoCodec: "h264", audioCodec: "aac", source: "probe", subtitles: [] },
  blockers: [],
  hls: null,
  subtitles: { embedded: [], files: [] },
  ...over,
});

describe("subtitleTracks", () => {
  it("builds a track per renderable sibling file", () => {
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "Kepler.S02E04.eng.srt", language: "en", label: "English", renderable: true },
          ],
        },
      }),
      target,
    );
    expect(tracks).toEqual([
      { src: "/stream/abc/1.vtt?k=cap", srclang: "en", label: "English", default: true },
    ]);
  });

  it("omits files the browser cannot render", () => {
    // ass/ssa/sub need a subtitle engine. Offering a <track> that shows nothing
    // is worse than offering none: the menu says the subtitle is on.
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "Kepler.S02E04.eng.ass", language: "en", label: "English", renderable: false },
          ],
        },
      }),
      target,
    );
    expect(tracks).toEqual([]);
  });

  it("defaults the first English track, not the first track", () => {
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "a.spa.srt", language: "es", label: "Spanish", renderable: true },
            { index: 2, filename: "a.eng.srt", language: "en", label: "English", renderable: true },
          ],
        },
      }),
      target,
    );
    expect(tracks.map((t) => t.default)).toEqual([false, true]);
  });

  it("defaults nothing when no track is English", () => {
    // Turning on a language the user does not read is worse than turning on
    // nothing; the menu is one click away either way.
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [
            { index: 1, filename: "a.spa.srt", language: "es", label: "Spanish", renderable: true },
          ],
        },
      }),
      target,
    );
    expect(tracks.map((t) => t.default)).toEqual([false]);
  });

  it("returns nothing for a null info", () => {
    expect(subtitleTracks(null, target)).toEqual([]);
  });

  it("encodes the capability into every src", () => {
    const tracks = subtitleTracks(
      info({
        subtitles: {
          embedded: [],
          files: [{ index: 1, filename: "a.srt", language: "", label: "a", renderable: true }],
        },
      }),
      { ...target, capability: "a b&c" },
    );
    expect(tracks[0]?.src).toBe("/stream/abc/1.vtt?k=a%20b%26c");
  });
});

describe("embeddedNotice", () => {
  it("names the languages muxed into the file", () => {
    // The line that turns the reported dead end into information: three tracks
    // were inside the file and nothing on screen said so.
    const notice = embeddedNotice(
      info({
        subtitles: {
          embedded: [
            { language: "spa", label: "" },
            { language: "eng", label: "" },
            { language: "por", label: "" },
          ],
          files: [],
        },
      }),
    );
    expect(notice).toBe(
      "Subtitles in this file: Spanish, English, Portuguese — pick one in your player.",
    );
  });

  it("counts untagged tracks rather than naming them", () => {
    const notice = embeddedNotice(
      info({ subtitles: { embedded: [{ language: "", label: "" }], files: [] } }),
    );
    expect(notice).toBe("This file has 1 subtitle track — pick it in your player.");
  });

  it("pluralises a count of untagged tracks", () => {
    const notice = embeddedNotice(
      info({
        subtitles: {
          embedded: [
            { language: "", label: "" },
            { language: "", label: "" },
          ],
          files: [],
        },
      }),
    );
    expect(notice).toContain("2 subtitle tracks");
  });

  it("says nothing when there are no embedded tracks", () => {
    expect(embeddedNotice(info({}))).toBe("");
  });

  it("says nothing for a null info", () => {
    expect(embeddedNotice(null)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/web/static/subtitleModel.test.ts`
Expected: FAIL — `Cannot find module './subtitleModel'`.

- [ ] **Step 3: Write the implementation**

Add to `src/web/static/playerModel.ts`, next to `infoPath`:

```ts
/** The `.vtt` path for a sibling subtitle in the same session. */
export function subtitlePath(target: PlayerTarget, index: number): string {
  const base = `/stream/${encodeURIComponent(target.sid)}/${index}.vtt`;
  return target.capability ? `${base}?k=${encodeURIComponent(target.capability)}` : base;
}
```

Create `src/web/static/subtitleModel.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/web/static/subtitleModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/subtitleModel.ts src/web/static/subtitleModel.test.ts src/web/static/playerModel.ts
git commit -m "feat(web): decide which subtitle tracks the player offers"
```

---

### Task 6: Wire subtitles into the player page

**Files:**
- Modify: `src/web/static/player.ts` — `showFallback` (line 131), `createVideo` (line 146), the play path (line 320)
- Modify: `src/web/static/styles.css` — a rule for the embedded-track line

**Interfaces:**
- Consumes: `subtitleTracks`, `embeddedNotice`, `TrackSpec` (Task 5).
- Produces: nothing consumed by later tasks.

This task has no unit test — `player.ts` is DOM wiring, which by design has no jsdom in this repo. It is verified by running the app, in Step 3.

- [ ] **Step 1: Make the changes**

In `src/web/static/player.ts`, add to the imports:

```ts
import { embeddedNotice, subtitleTracks, type TrackSpec } from "./subtitleModel";
```

Change `showFallback` to take the info and append the embedded line:

```ts
function showFallback(
  reason: FallbackReason,
  filename: string,
  info: StreamInfoResponse | null = null,
): void {
  const card = document.createElement("div");
  card.className = "card fallback";

  const title = document.createElement("h2");
  title.textContent = "This one needs a real player";

  const body = document.createElement("p");
  body.className = "fallback-body";
  body.textContent = fallbackMessage(reason, filename);

  card.append(title, body);

  // The subtitles the file carries, when it has any. A card that says "open
  // this elsewhere" and then does not mention the three subtitle tracks inside
  // is the exact gap this feature exists to close.
  const subs = embeddedNotice(info);
  if (subs) {
    const line = document.createElement("p");
    line.className = "fallback-subs";
    line.textContent = subs;
    card.append(line);
  }

  stage.replaceChildren(card);
}
```

Update both existing calls: the one at `src/web/static/player.ts:284` (`showFallback("no-link", "")`) stays as-is, and the one in the play path becomes `showFallback(chosen.reason ?? "container", target.filename, info)`.

Add a helper next to `createVideo`:

```ts
/**
 * Attach subtitle tracks to a `<video>`.
 *
 * `label` comes from a filename, i.e. from whoever made the torrent, so it is
 * set as a property and never as markup — the same rule as everything else in
 * this file.
 */
function addTracks(video: HTMLVideoElement, specs: TrackSpec[]): void {
  for (const spec of specs) {
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.src = spec.src;
    track.srclang = spec.srclang;
    track.label = spec.label;
    track.default = spec.default;
    video.append(track);
  }
}
```

In the play path, after `const info = await fetchInfo(target);`, compute the specs once:

```ts
  const tracks = subtitleTracks(info, target);
```

Call `addTracks(video, tracks)` immediately after each `createVideo()` — there are two sites, the `provider-hls` branch and `mountVideo`. For `mountVideo`, thread the specs in as a parameter rather than reaching for a module-level variable, and add them before the element is appended to the stage so no track loads late.

In `src/web/static/styles.css`, add after the `.fallback-body` rule (around line 1196):

```css
/* The embedded-subtitle line under a fallback card. Dimmer than the
   explanation above it: it is a useful aside, not the reason for the card. */
.fallback-subs {
  margin: 0.6rem 0 0;
  color: var(--dim);
  font-size: 0.85rem;
}
```

- [ ] **Step 2: Verify it builds and imports nothing node-only**

Run: `npm run build && npm run typecheck && npm run lint`
Expected: all pass. `npm run build` is the only check that `src/web/static/` imports no `node:*`.

- [ ] **Step 3: Verify by running it**

```bash
npm run dev -- serve --web --port 8899
```

Open the dashboard, play a torrent that has a sibling `.srt`, and confirm the browser's CC menu lists it and it renders. Then open one the browser cannot play and confirm the fallback card names the embedded languages. Both are wiring that no test reaches — this step is the verification.

- [ ] **Step 4: Commit**

```bash
git add src/web/static/player.ts src/web/static/styles.css
git commit -m "feat(web): show subtitle tracks in the player and name embedded ones on the card"
```

---

### Task 7: Player subtitle flags for the TUI

**Files:**
- Create: `src/util/subtitleFlags.ts`
- Test: `src/util/subtitleFlags.test.ts`
- Modify: `src/util/player.ts` — `spawnPlayer` (line 217), `openWithApp` (line 238), `launchPlayer` (line 256)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `subtitleArgs(command: string, subtitleUrl: string): string[]` — `[]` for an unknown player
  - `launchPlayer(command: string, url: string, subtitleUrl?: string): Promise<boolean>` — the existing two-argument calls keep working unchanged

- [ ] **Step 1: Write the failing test**

Create `src/util/subtitleFlags.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { subtitleArgs } from "./subtitleFlags";

const URL = "http://box.test:9161/stream/abc/1.vtt?k=cap";

describe("subtitleArgs", () => {
  it("uses --sub-file for mpv", () => {
    expect(subtitleArgs("mpv", URL)).toEqual([`--sub-file=${URL}`]);
  });

  it("uses --sub-file for mpv.net", () => {
    expect(subtitleArgs("mpvnet", URL)).toEqual([`--sub-file=${URL}`]);
  });

  it("uses --mpv-sub-file for IINA, which prefixes mpv's own flags", () => {
    expect(subtitleArgs("iina", URL)).toEqual([`--mpv-sub-file=${URL}`]);
  });

  it("uses --input-slave for VLC", () => {
    expect(subtitleArgs("vlc", URL)).toEqual([`--input-slave=${URL}`]);
  });

  it("recognises a player given as an absolute path", () => {
    // The configured command is often a full path on Windows and macOS.
    expect(subtitleArgs("/Applications/VLC.app/Contents/MacOS/VLC", URL)).toEqual([
      `--input-slave=${URL}`,
    ]);
    expect(subtitleArgs("C:\\Program Files\\VideoLAN\\VLC\\vlc.exe", URL)).toEqual([
      `--input-slave=${URL}`,
    ]);
  });

  it("recognises the macOS app-bundle names torlink launches with `open -a`", () => {
    expect(subtitleArgs("VLC", URL)).toEqual([`--input-slave=${URL}`]);
    expect(subtitleArgs("IINA", URL)).toEqual([`--mpv-sub-file=${URL}`]);
  });

  it("returns nothing for an unknown or custom command", () => {
    // A user's own wrapper script takes whatever arguments it takes. Guessing a
    // flag would break a launch that works today, so an unknown player gets the
    // URL alone and the caller says the subtitle was not attached.
    expect(subtitleArgs("my-player.sh", URL)).toEqual([]);
    expect(subtitleArgs("", URL)).toEqual([]);
  });

  it("returns nothing when there is no subtitle url", () => {
    expect(subtitleArgs("mpv", "")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/subtitleFlags.test.ts`
Expected: FAIL — `Cannot find module './subtitleFlags'`.

- [ ] **Step 3: Write the implementation**

Create `src/util/subtitleFlags.ts`:

```ts
/**
 * How to tell each media player to side-load a subtitle.
 *
 * Kept apart from ./player.ts so the table is testable without spawning
 * anything, and dependency-free so it stays that way.
 *
 * An unknown command gets no flag at all. The configured player may be a user's
 * own wrapper script that takes arguments we cannot guess, and inventing one
 * would break a launch that works today — the caller says the subtitle was not
 * attached rather than risking that.
 */

// Matched against the command's basename, lowercased, extension stripped — the
// configured value is as often "/Applications/VLC.app/Contents/MacOS/VLC" or
// "vlc.exe" as it is "vlc".
const FLAGS: Record<string, string> = {
  mpv: "--sub-file",
  mpvnet: "--sub-file",
  "mpv.net": "--sub-file",
  iina: "--mpv-sub-file",
  "iina-cli": "--mpv-sub-file",
  vlc: "--input-slave",
  vlccli: "--input-slave",
};

function commandKey(command: string): string {
  const slash = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  const base = (slash >= 0 ? command.slice(slash + 1) : command).toLowerCase();
  return base.replace(/\.(exe|app|com|bat|cmd)$/, "");
}

/** The extra argv for a subtitle, or `[]` when we should not pass one. */
export function subtitleArgs(command: string, subtitleUrl: string): string[] {
  if (!subtitleUrl) return [];
  const flag = FLAGS[commandKey(command)];
  return flag ? [`${flag}=${subtitleUrl}`] : [];
}
```

In `src/util/player.ts`, add the import:

```ts
import { subtitleArgs } from "./subtitleFlags";
```

Change the three functions to carry extra argv. `spawnPlayer`:

```ts
function spawnPlayer(command: string, url: string, extra: string[] = []): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, [...extra, url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
```

(the rest of the body is unchanged)

`openWithApp` — note the `--args` separator, which is what makes `open -a` pass anything through to the application:

```ts
function openWithApp(app: string, url: string, extra: string[] = []): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // `open -a App url` passes the url as a document. Anything after --args
      // goes to the application instead, so a flag has to sit there or `open`
      // will treat it as its own and fail.
      const argv = extra.length > 0 ? ["-a", app, url, "--args", ...extra] : ["-a", app, url];
      const proc = spawn("open", argv, { stdio: "ignore", windowsHide: true });
```

(the rest of the body is unchanged)

`launchPlayer`:

```ts
/**
 * Launch a media player on a URL. Tries the command directly first (a CLI on
 * PATH or an absolute path); on macOS, if that can't be spawned, falls back to
 * `open -a <command>` so a bare app name like "VLC" or "IINA" still works.
 * Resolves false only when neither route launches anything.
 *
 * `subtitleUrl` side-loads a subtitle where the player is one we know the flag
 * for (see ./subtitleFlags.ts). An unknown player launches exactly as before,
 * with no flag — the caller is responsible for saying so.
 */
export async function launchPlayer(
  command: string,
  url: string,
  subtitleUrl = "",
): Promise<boolean> {
  const extra = subtitleArgs(command, subtitleUrl);
  if (await spawnPlayer(command, url, extra)) return true;
  if (process.platform === "darwin") return openWithApp(command, url, extra);
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/util/subtitleFlags.test.ts src/util/player.test.ts && npm run typecheck`
Expected: PASS. The existing two-argument `launchPlayer` callers still compile because the third parameter has a default.

- [ ] **Step 5: Commit**

```bash
git add src/util/subtitleFlags.ts src/util/subtitleFlags.test.ts src/util/player.ts
git commit -m "feat(util): side-load a subtitle when launching a known player"
```

---

### Task 8: Subtitles in the TUI

**Files:**
- Modify: `src/ui/components/StreamFilePrompt.tsx` — the row rendering
- Modify: `src/util/player.ts` — `PlayDeps`, `detectAndPlay`, `attemptAutoPlay`
- Modify: `src/ui/App.tsx:1364` (`playStream`), `:1516` and `:1666` (the two `streamCandidates` call sites), `:1844` (the `setMediaPlayer` launch)
- Modify: `src/ui/testHarness.ts` if a new `Store` field is added
- Test: `src/ui/components/StreamFilePrompt.test.tsx`, `src/util/player.test.ts`

**Interfaces:**
- Consumes: `subtitlesFor`, `preferredSubtitle` (Task 1); `launchPlayer`'s third parameter and `subtitleArgs` (Task 7).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `src/util/player.test.ts`, following that file's existing `deps`-injection pattern:

```ts
it("passes the subtitle url through attemptAutoPlay to the launcher", () => {
  // The path nearly every user takes: a configured player. Wiring only the
  // after-the-prompt launch would leave the feature dead for all of them.
  const seen: { command: string; url: string; sub?: string }[] = [];
  return attemptAutoPlay(
    "mpv",
    "http://up.test/v.mkv",
    "http://up.test/v.eng.srt",
    {
      launch: (command, url, sub) => {
        seen.push({ command, url, sub });
        return Promise.resolve(true);
      },
    },
  ).then(() => {
    expect(seen).toEqual([
      { command: "mpv", url: "http://up.test/v.mkv", sub: "http://up.test/v.eng.srt" },
    ]);
  });
});

it("passes an empty subtitle url when there is none", async () => {
  let seen = "unset";
  await attemptAutoPlay("mpv", "http://up.test/v.mkv", "", {
    launch: (_c, _u, sub) => {
      seen = sub ?? "undefined";
      return Promise.resolve(true);
    },
  });
  expect(seen).toBe("");
});
```

Add to `src/ui/components/StreamFilePrompt.test.tsx`:

```tsx
it("marks a file that has a matching subtitle", () => {
  const files = [
    { url: "http://up.test/0", filename: "Kepler.S02E04.1080p.WEB-DL.mkv", bytes: 900 },
    { url: "http://up.test/1", filename: "Kepler.S02E05.1080p.WEB-DL.mkv", bytes: 900 },
  ];
  const { lastFrame } = render(
    <StreamFilePrompt
      width={80}
      files={files}
      allFiles={[...files, { url: "http://up.test/2", filename: "Kepler.S02E04.eng.srt", bytes: 40 }]}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  );
  const [e04, e05] = lastFrame()!.split("\n").filter((l) => l.includes("Kepler"));
  expect(e04).toContain("CC");
  expect(e05).not.toContain("CC");
});

it("marks nothing when the torrent has no subtitle files", () => {
  const files = [{ url: "http://up.test/0", filename: "Harrowgate.S03.1080p.WEB-DL.mkv", bytes: 900 }];
  const { lastFrame } = render(
    <StreamFilePrompt width={80} files={files} allFiles={files} onSelect={() => {}} onCancel={() => {}} />,
  );
  expect(lastFrame()).not.toContain("CC");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/components/StreamFilePrompt.test.tsx src/util/player.test.ts`
Expected: FAIL — `allFiles` is not a prop, no `CC` marker is rendered, and `attemptAutoPlay` takes no subtitle argument.

- [ ] **Step 3: Write the implementation**

In `src/ui/components/StreamFilePrompt.tsx`, add the prop:

```tsx
  /**
   * Every file in the torrent, not just the video candidates in `files`.
   *
   * The subtitle matcher needs the unfiltered list: `files` has already been
   * through `streamCandidates`, which drops exactly the .srt files this is
   * looking for. Defaults to `files`, so a caller that has not been updated
   * simply shows no markers rather than crashing.
   */
  allFiles?: StreamFile[];
```

Destructure it with `allFiles`, defaulting to `files`, and compute per-row:

```tsx
  const withSubs = useMemo(() => {
    const pool = allFiles ?? files;
    return new Set(files.filter((f) => subtitlesFor(f, pool).length > 0).map((f) => f.url));
  }, [files, allFiles]);
```

In the row rendering, add the marker next to the existing watched `✓`:

```tsx
{withSubs.has(file.url) ? <Text color={COLOR.dim}> CC</Text> : null}
```

Import `subtitlesFor` from `../../util/subtitleFiles`.

In `src/ui/App.tsx`, pass the unfiltered list at both `StreamFilePrompt` render sites: `allFiles={<the session's full file list>}` — the same array `streamCandidates(...)` is called on.

**There are two launch paths and both need this.** `playStream` (`src/ui/App.tsx:1364`) is the primary one — it calls `attemptAutoPlay` at line 1369 — and `setMediaPlayer` (`src/ui/App.tsx:1844`) is the fallback used after the user types a player command. Wiring only the second would leave the feature dead for everyone whose player is already configured, which is nearly everyone.

Thread the subtitle URL through both. First widen the two helpers in `src/util/player.ts` so the URL has somewhere to travel:

```ts
export interface PlayDeps {
  detect?: () => Promise<string | null>;
  launch?: (command: string, url: string, subtitleUrl?: string) => Promise<boolean>;
}
```

`detectAndPlay` and `attemptAutoPlay` each gain a trailing `subtitleUrl = ""` parameter and pass it to `launch(...)`. Both already take `deps` last, so add the new parameter **before** `deps` and update the two internal call sites; every existing caller passes neither and is unaffected.

Then in `src/ui/App.tsx`, give `playStream` a fourth parameter:

```tsx
const playStream = useCallback(
  async (url: string, name?: string, onPlayed?: () => void, subtitleUrl = "") => {
    if (!config) return;
    const configured = resolveMediaPlayer(config);
    const outcome = await attemptAutoPlay(configured, url, subtitleUrl);
```

and at each site that resolves a file to play, compute the subtitle from the session's **unfiltered** list before calling it:

```tsx
const preferred = preferredSubtitle(subtitlesFor(chosenFile, allFiles));
void playStream(chosenFile.url, name, onPlayed, preferred?.url ?? "");
```

Do the same at the `setMediaPlayer` launch (`src/ui/App.tsx:1844`), where `ctx` already carries the pending stream — add the subtitle URL to `pendingStream` when it is set so it survives the prompt, rather than recomputing it there with a file list that scope does not have.

Note this passes the **upstream** URL, not a `/stream/…vtt` handle: the TUI hands players the upstream URL for the video too, so the subtitle must come from the same place. No conversion happens on this path, which is correct — mpv, IINA and VLC all read SRT and ASS natively.

When a subtitle matched but the player is one `subtitleArgs` does not know, say so rather than staying silent. In `playStream`'s success branch:

```tsx
const attached = subtitleUrl !== "" && subtitleArgs(outcome.player ?? "", subtitleUrl).length > 0;
const subNote = subtitleUrl !== "" && !attached ? " · subtitle not loaded" : "";
setNotice(
  `${ICON.done} Streaming ${name ? `${truncate(cleanText(name), 28)} ` : ""}in ${outcome.player}${copied ? " · link copied" : ""}${subNote}`,
);
```

Add the imports `src/ui/App.tsx` needs for the above:

```tsx
import { preferredSubtitle, subtitlesFor } from "../util/subtitleFiles";
import { subtitleArgs } from "../util/subtitleFlags";
```

`chosenFile` and `allFiles` in that snippet are whatever the surrounding scope already calls the selected `StreamFile` and the session's unfiltered file array — read the call site and use its own names rather than introducing these.

If any of this requires a new `Store` field, add the matching entry to **both** `makeStore` (`scripts/render-previews-impl.tsx`) and `makeTestStore` (`src/ui/testHarness.ts`) — `npm run previews` and `npm run typecheck` respectively break otherwise.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/ && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Verify by running it**

```bash
npm run dev
```

Stream a torrent that has a sibling `.srt`, confirm the picker marks the episode `CC`, and confirm the subtitle is loaded when the player opens.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/StreamFilePrompt.tsx src/ui/App.tsx
git add -u
git commit -m "feat(tui): mark files with subtitles and side-load them on play"
```

---

### Task 9: Documentation and the rename-trap sweep

**Files:**
- Modify: `README.md:229`
- Verify: the whole suite

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the README**

`README.md:229` currently reads:

```markdown
- **No subtitles, no scrubber.** [Continue watching](#continue-watching) does play the next episode
  automatically when a row names one — it just can't resume *where* you left off, because nothing here
  reads back from mpv, iina, vlc, or a browser tab; none of them report a position.
```

Replace with:

```markdown
- **No scrubber.** [Continue watching](#continue-watching) does play the next episode
  automatically when a row names one — it just can't resume *where* you left off, because nothing here
  reads back from mpv, iina, vlc, or a browser tab; none of them report a position.
- **Subtitles, partly.** A `.srt` or `.vtt` shipped alongside the video is matched to it and shown in
  the browser's own subtitle menu; ASS and SSA are handed to external players, which render them, but
  the browser can't. Tracks muxed *inside* the file are named on the fallback card so you know they're
  there — pulling one out would mean running ffmpeg, which torlink doesn't do.
```

- [ ] **Step 2: Check the web UI's limitations list is still true**

Read the surrounding "What the browser can't do yet" section and confirm nothing else in it now contradicts the shipped behaviour. `CLAUDE.md` requires this check on any change that touches the browser's capabilities.

- [ ] **Step 3: Run the rename-trap sweep**

No fixtures were renamed by this plan, but new negative assertions were added. Confirm each still names something the tests actually put in play:

```bash
grep -rn "not.toContain\|not.toBe" src/web/stream.test.ts src/web/static/subtitleModel.test.ts src/util/subtitleFiles.test.ts | cut -c1-140
```

For each hit, confirm the string it names is something the test genuinely produces — an assertion that nothing contains `"evil"` is worthless if nothing in the test ever contained it. The `.m3u` injection test is the one that matters: verify the crafted filename actually reaches the code under test.

- [ ] **Step 4: Full verification**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

Expected: all green, with the one known pre-existing `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe what subtitle support does and does not do"
```
