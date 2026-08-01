# Subtitles

**Date:** 2026-08-01
**Status:** Approved (design)
**Builds on:** the streaming stack (`src/web/stream.ts`, `src/util/videoFiles.ts`,
`src/core/probe.ts`) and the web player page.

## Motivation

torlink has no subtitle support of any kind. `README.md:229` says so plainly —
"**No subtitles, no scrubber.**" — and the original streaming design listed them
out of scope. Two distinct things are missing, and they were found by
investigating one report ("I couldn't get subtitles for a season pack I was
playing through the .m3u in VLC").

**Embedded tracks are invisible.** The reported pack turned out to have no
sibling subtitle files at all: ten mp4s, each with three muxed `mov_text` tracks
(spa/eng/por). Those tracks survive torlink's byte-range proxy intact — verified
with ffprobe against a live `/stream` URL, and VLC's mp4 demuxer logs all three
when handed the `.m3u`:

    adding track[Id 0x4] subtitle (enable)  language spa
    adding track[Id 0x5] subtitle (disable) language eng
    adding track[Id 0x6] subtitle (disable) language por

So that case was never broken — VLC auto-enabled **Spanish**, and English sat
loaded but off under Subtitle → Sub Track. Nothing in torlink told the user the
tracks existed or which one was playing. The browser player is worse: it has no
subtitle support at all, and for this file it cannot play the video either
(HEVC + eac3, no provider HLS), so the user gets the fallback card with no
indication that subtitles are sitting inside the file.

**Sibling subtitle files are unreachable.** `streamCandidates`
(`src/util/videoFiles.ts:83`) filters every non-video file out before either
front end draws a picker. That is right for choosing *what to play*, but it means
a release shipping `Subs/` or `Episode.S01E01.en.srt` hides those files
completely. They are byte-addressable on the server — `src/web/stream.ts:336`
never checks extension — but nothing lists them, links them, or associates them
with a video.

## Scope

**In scope**

- Sibling subtitle files: matched to the chosen video, served as WebVTT, attached
  in both front ends.
- Embedded subtitle tracks: detected by the existing ffprobe call and *reported*.
- Both front ends, per the two-front-ends rule in `CLAUDE.md`.

**Out of scope**

- **Extracting embedded tracks.** Would require spawning ffmpeg, which torlink
  never does in production (`findFfmpeg` in `src/util/ffmpegBin.ts:137` has no
  production caller). It would also only pay off for files the browser can
  already play — not the HEVC/eac3 case that prompted this.
- **Fetching subtitles from the internet** (OpenSubtitles and friends). A
  separate feature with its own credentials, rate limits and licensing.
- **Rendering ASS/SSA in the browser.** Needs a real subtitle engine; `<track>`
  cannot do it. Those files are still matched and still handed to VLC/mpv, which
  render them natively.
- **Probing in the TUI.** VLC lists embedded tracks in its own menu the moment it
  opens the file; a 15-second ffprobe to print the same information first is a
  cost with no return.

## Design

### 1. Shared pure modules

Two new dependency-free modules beside `videoFiles.ts`, imported by both
surfaces. The reason is the one `videoFiles.ts` gives in its own header: this
project has been bitten three times by a hand-copied helper drifting between the
front ends. Two copies of "which subtitle goes with this episode" would drift the
same way and the divergence would be invisible until someone compared screens.

**`src/util/subtitleFiles.ts`**

    isSubtitleFilename(name)   srt, vtt, ass, ssa, sub
    subtitlesFor(video, files) the three rules below, in order
    subtitleLanguage(name)     language token + forced/sdh flags
    preferredSubtitle(matches) English, else the first

Matching rules, first rule that yields anything wins:

1. **Basename prefix** — the subtitle's basename starts with the video's
   basename. `Show.S01E01.1080p.mkv` ← `Show.S01E01.1080p.eng.srt`.
2. **Shared SxxExx token** — both paths carry the same season/episode token.
   Catches the `Subs/` folder layout scene releases actually use:
   `Subs/Show.S01E01/2_English.srt`.
3. **Single video** — if the torrent has exactly one video file, every subtitle
   in it belongs to that video. `Kestrel.2010.1080p.mkv` ← `Subs/English.srt`.

Rules stop there deliberately. Fuzzy title matching was considered and rejected:
it would occasionally attach the wrong episode's subtitle, which is worse than
attaching none.

Two categories of subtitle, which are not interchangeable:

| | `srt`, `vtt` | `ass`, `ssa`, `sub` |
| --- | --- | --- |
| Browser `<track>` | yes | no — needs a subtitle engine |
| VLC / mpv attach | yes | yes, rendered natively |

**`src/util/srtToVtt.ts`** — pure text transform. Strips a BOM, normalises CRLF,
emits the `WEBVTT` header, converts `,` to `.` in timestamps, drops cue index
lines. A file that is already WebVTT passes through unchanged. Decoding falls
back to latin1 when the bytes are not valid UTF-8, because `.srt` files are
frequently Windows-1252 and a mojibake subtitle is worse than none.

`videoFiles.ts` is **not** modified. Subtitles must stay out of
`streamCandidates` or they become things the user can pick to *play*.

### 2. Server: one new representation, one changed

**`.vtt` joins `.m3u` and `.info`** in `splitRepresentation`
(`src/web/stream.ts:157`), which means it inherits every session, capability,
readiness and bounds guard already in that path. It fetches the subtitle's bytes
upstream, converts, and serves `text/vtt; charset=utf-8`.

Two guards this representation needs that the others do not:

- **Refuse any index whose filename is not a subtitle extension.** Without it,
  `.vtt` is a general-purpose "fetch this file into memory and call it text"
  route pointed at a 12 GB video.
- **Cap the body at 4 MiB.** A subtitle is kilobytes; anything larger is not one.

**The `.m3u` gains an input-slave line**, and only when a preferred subtitle
exists:

    #EXTM3U
    #EXTVLCOPT:input-slave=http://host/stream/<sid>/7.vtt?k=<cap>
    http://host/stream/<sid>/2?k=<cap>

Both URLs are built from `streamHandle` and the re-encoded capability, so the
existing constraint at `src/web/stream.ts:446` still holds exactly: nothing in
the body is derived from the torrent's own text. With no match the body stays
byte-identical to today's single bare URL.

`.info` grows `subtitles: { embedded: EmbeddedSubtitle[], files: SubtitleFile[] }`,
typed in `src/web/wire.ts`.

### 3. Embedded tracks: widen the probe, do not extract

`ffprobeArgs` (`src/core/probe.ts:29`) adds `stream_tags=language,title` to its
`-show_entries`, and `parseFfprobe` stops discarding rows with
`codec_type === "subtitle"`. That is the entire change — ffprobe is already a
runtime dependency, so this costs nothing new.

`MediaFacts` gains `subtitles: EmbeddedSubtitle[]`, which `classifyFromName`
returns empty: a filename cannot know what is muxed inside.

`src/core/probe.test.ts:78` currently asserts subtitle streams are ignored. That
test inverts.

### 4. Browser player

- Matched `srt`/`vtt` files become real `<track kind="subtitles" srclang label>`
  children of the `<video>`, giving the browser's native CC menu. The first
  English track gets `default`.
- The **fallback card** — the "needs a real player" case — gains a line naming
  the embedded track languages: *"Subtitles in this file: English, Spanish,
  Portuguese — pick one in your player."* This is what turns the reported dead
  end into useful information.
- The decision of which tracks to build is a pure `src/web/static/subtitleModel.ts`
  with real tests. `player.ts` stays DOM wiring, per the rule in `CLAUDE.md` that
  has been caught in review twice.

### 5. TUI

- `StreamFilePrompt` marks candidates that have matching subtitle files.
- `launchPlayer` takes an optional subtitle URL and applies a flag table:

      mpv      --sub-file=<url>
      mpvnet   --sub-file=<url>
      iina     --mpv-sub-file=<url>
      vlc      --input-slave=<url>
      <other>  no flag

  An unknown or user-configured player command launches unchanged, and the notice
  says the subtitle was not attached rather than staying silent about it.
- No probing. See Scope.

## Error handling

Every failure is soft, matching the house style:

- **No subtitle matches** — the `.m3u` is byte-identical to today's, no `<track>`
  elements, no marks in the picker. The feature is invisible when it has nothing
  to say.
- **Upstream fetch of a subtitle fails** — `502`, matching what `proxyUpstream`
  already does for an unreachable upstream. The video is unaffected: a `<track>`
  whose URL fails leaves the video playing without captions, which is the
  browser's own behaviour and needs no handling from us.
- **Conversion produces nothing usable** — served as-is rather than as an empty
  file, on the grounds that VLC may still parse what our transform did not.
- **ffprobe unavailable or times out** — unchanged from today. `probeUrl` returns
  null, the caller falls back to `classifyFromName`, and `subtitles.embedded` is
  empty. No new failure mode.

## Testing

- `subtitleFiles.test.ts` — the three rules, including the case each exists for,
  plus the negative: an unrelated `.srt` in a multi-episode pack matches nothing.
- `srtToVtt.test.ts` — timestamp conversion, index stripping, BOM, CRLF, latin1
  fallback, already-VTT passthrough.
- `stream.test.ts` — the `.vtt` representation: capability enforced, non-subtitle
  index refused, size cap, and the `.m3u` both with and without a match. The
  existing negative assertions in that file are checked against the rename trap
  documented in `CLAUDE.md`.
- `subtitleModel.test.ts` — which `<track>` elements get built, which is
  `default`, and that ASS/SSA never becomes a `<track>`.
- `probe.test.ts` — the inverted assertion, plus language and title tags.
- Fixtures use the invented cast from `CLAUDE.md` (`Kepler.S02E04`,
  `Harrowgate.S03`, `Kestrel.2010`).

## Documentation

`README.md:229` currently states there are no subtitles. It changes to describe
what now works and what does not: sibling files yes, embedded tracks reported but
not rendered in the browser, ASS/SSA in external players only. The web UI's own
limitations list is checked in the same pass, per `CLAUDE.md`.
