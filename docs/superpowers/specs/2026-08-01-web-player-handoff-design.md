# Handing a stream to something that can play it

The browser player offers four ways out to a real player: copy the URL, download a `.m3u`,
open VLC, and download the rest of the season as one playlist. Three of them are broken or
misleading in a way a user hits on the first try. This fixes those three, and records why the
fourth complaint was not a bug.

## What is wrong today

1. **"Copy stream URL" never copies.** `player.ts` reads `navigator.clipboard`, finds it
   absent — the async clipboard exists only in a secure context, and the normal way to reach
   this dashboard is `http://192.168.x.x` — and shows "Copying needs a secure context —
   download the .m3u instead." The advice is unhelpful: the user cannot make their LAN a
   secure context, and there is a route that works in this exact situation.

2. **"Open in VLC" on macOS does nothing.** `vlcLinks` hands macOS the `vlc-x-callback://`
   scheme, which belongs to VLC's *iOS* app. Verified against a real install:
   `/Applications/VLC.app/Contents/Info.plist` registers `http`, `https`, `ftp`, `mms`,
   `mmsh`, `rtsp`, `udp`, `rtp`, `rtmp*`, `sftp` and `smb` — **no `vlc://` and no
   `vlc-x-callback://`**. Nothing on the machine claims the URL, so the click is a silent
   no-op, which is precisely the failure `vlcLinks`' own doc comment says it exists to avoid
   ("a button there would be a button that does nothing").

3. **Playlist entries have no titles.** The `.m3u` body is bare URLs, so a media player labels
   each entry with its URL — `…/stream/<uuid>/8?k=…`. A thirteen-entry season playlist is then
   thirteen indistinguishable rows, and the user cannot tell which one is the episode they
   want until it starts playing.

4. **"Rest of season" is not the rest of a season.** It is "this file and every later file in
   filename order". Started from a bonus feature it yields every remaining extra *and then the
   whole season*, under a label that promises otherwise. Started from an episode it is only
   accidentally right: in the reported torrent the extras happened to sort before the
   episodes, and a torrent naming an extra `Show - S04E05 - Deleted Scene` would drop it into
   the middle of the season playlist.

### The `127.0.0.1` report was not a bug

A playlist download was observed containing `http://127.0.0.1:9171/stream/…`. The route builds
every entry from the request's own `Host` header (`requestOrigin`, `src/web/stream.ts`), and the
evidence confirms it did: the port in that file is **9171**, not the 9161 the user was browsing.
The download came from a tab pointed at a different server — a development instance on another
port. The playlist downloaded from `192.168.0.98:9161` in the same session names
`192.168.0.98:9161` in every entry.

No change is warranted. A regression test pins the behaviour for a *non-video* file
specifically, since that is the case the report was about, so a future refactor cannot quietly
introduce a per-file origin.

## The four changes

### 1. Copy by whichever route the browser allows

Cherry-pick the existing commit `2e6ba39` ("fix(web): copy the stream URL on an insecure
origin"), which adds `src/web/static/copyText.ts` and its tests. Not `aeb28b8` from the same
branch, which is an unrelated subtitles design document.

`copyText` tries `navigator.clipboard.writeText` where it exists, and otherwise falls back to
`document.execCommand("copy")`. It **returns synchronously** on the fallback path, and that is
load-bearing rather than stylistic: `execCommand("copy")` is only permitted inside the task the
user's click started, so a single `await` before it hands control back to the event loop and
Safari refuses. When both routes fail it returns `"manual"` and the page reveals a read-only
field holding the URL, already selected — a route that cannot fail, because the user does the
copying.

Nothing else in the codebase needs it: `app.ts` has no clipboard call site, so this stays one
consumer and one module.

### 2. No dead VLC button

`vlcLinks` returns `[]` for `macos`, joining Windows and Linux. Only `ios`
(`vlc-x-callback://`) and `android` (`intent://…package=org.videolan.vlc`) keep a link, and
both of those are registered handlers on their platform.

`detectPlatform` is unchanged and still reports `macos` — the platform is a fact, and what we
offer it is the decision. Desktop keeps **Download .m3u**, which works on all three desktop
platforms and does not presume VLC is what the user plays video in.

One consequence to follow through: `interruptedNotice` currently says "Download the .m3u or
open it in VLC to carry on watching", which on desktop will name a button that is no longer on
screen. It becomes "Download the .m3u and carry on watching there." — true everywhere, and the
mobile user still has the VLC button in front of them. `fallbackMessage` needs no change; it
says "open it in a real player", which names no button.

### 3. Titles in the playlist

The body gains an `#EXTM3U` header and one `#EXTINF:-1,<title>` line per entry. Duration is
`-1` because this route does not know it, which is the documented "unknown" value and what
every player accepts.

The current comment refuses `#EXTINF` on the grounds that it means interpolating a torrent's
filename — attacker-controlled text — into a file another application parses. That objection is
answered rather than overruled, and the answer is the reason this is a module of its own:

- **Newlines are the real hazard**, and they are removed. A filename containing `\n` followed
  by a URL would otherwise *add an entry to the playlist*, pointing wherever the torrent's
  author chose. CR, LF and every C0/C1 control character go.
- A leading `#` is stripped, so a title cannot pose as a playlist directive.
- The result is capped at 120 characters.
- Commas are deliberately kept: `#EXTINF`'s duration separator is the *first* comma on the
  line, and everything after it is the title, so "Beware the Jabberwock, My Son" is safe and
  correct as written.

A new pure module `src/util/playlistTitle.ts` derives the title. `src/util/`, not `src/web/`,
because the server builds the body and `parseRelease` — which it needs — already lives there.

`playlistTitle(filename)`:

1. Strip the directory prefix and the extension.
2. Find a season/episode tag (`S04E05`, including multi-episode `S04E05E06`). With one, the
   title is the show's name (from `parseRelease`, when it found one) plus the tag —
   `Harrowgate S03E01`.
3. An episode *name* is appended as ` · <name>` only when the filename used the
   spaced-dash convention Sonarr and Plex write (` - ` / ` – ` / ` — ` after the tag), taking
   the text up to the next ` (` or ` [`. So
   `Kepler (2019) - S02E04 - Ashfall Rising (1080p BluRay x265 GROUP).mkv` becomes
   `Kepler S02E04 · Ashfall Rising`, while the dot-delimited
   `Harrowgate.S03E01.1080p.WEB-DL.mkv` stops at `Harrowgate S03E01` rather than appending
   `1080p WEB-DL`. The separator is what distinguishes an episode name from release junk;
   guessing at dot-delimited text would put `1080p WEB DL` in front of the user as a title.
4. Without a tag: `parseRelease`'s title and year — `Kestrel.2010.1080p.BluRay.x264.mkv` →
   `Kestrel 2010`. Where it parses nothing, the basename with `.` and `_` replaced by spaces, so
   `Bonus_Gag_Reel_1.mkv` reads as `Bonus Gag Reel 1`.
5. If nothing survives, fall back to the sanitised basename, and failing that `"stream"`. The
   function never returns an empty string, because an `#EXTINF:-1,` with nothing after the
   comma is worse than a URL.

Titles are added to the single-file playlist as well as the `?rest=1` one. One code path, and a
named single entry costs nothing.

### 4. "Rest of season" means the rest of that season

A new shared module `src/util/restPlaylist.ts` answers both halves of this, because the server
picks the files and the browser writes the label, and two implementations of one rule is the
copy-then-drift bug this codebase has recorded four times:

```ts
export type RestKind = "season" | "everything";
export interface RestPlaylist {
  kind: RestKind;
  /** Session indexes, in play order, current file first. Never empty. */
  indexes: number[];
}
export function restPlaylist<T extends SizedFile & { index: number }>(
  files: readonly T[],
  index: number,
): RestPlaylist;
```

- Candidates are `streamCandidates` then `sortStreamFiles(…, "name")`, unchanged — the order
  the picker and the episode list already use.
- When the current file parses to **both** a season and an episode: `kind: "season"`, and the
  entries are the current file plus every later candidate whose parsed season equals it *and*
  which names an episode of its own. That drops the extras this case is about — verified
  against `parseRelease`, `Harrowgate.S03/Bonus_Gag_Reel_1.mkv` yields a season but no episode,
  so it is excluded, where today it is included.
- **It does not drop an extra that poses as an episode.** `Harrowgate.S03E02.Deleted.Scenes.mkv`
  parses as S03E02 and stays in, next to the real E02. Deduplicating by episode number would
  remove it — and would also remove `S03E02.Part2` next to `S03E02.Part1`, which is losing half
  an episode to tidy up a duplicate. Including one extra is the cheaper mistake, so there is no
  dedupe, and a test records the choice.
- Otherwise — a bonus feature, a film, an unparseable name: `kind: "everything"`, and the
  entries are today's behaviour, the sorted slice from the current file onward.
- An index naming no candidate yields `{ kind: "everything", indexes: [index] }`, matching what
  `restOfSession` does now for a hand-edited URL.

Generic over the shape for the reason `sortStreamFiles` is: the server holds `StreamFile` with
an upstream `url`, the browser holds `PublicStreamFile` with a `handle`, and each keeps the
field that addresses its file. The server maps `session.files` to add the `index` the browser's
type already carries.

Server side, `restOfSession` in `src/web/stream.ts` is replaced by a call to it.

Browser side, `upNextView` gains the button's text, so the decision is in a tested module
rather than in `player.ts`:

- `kind: "season"` → "Download rest of season .m3u"
- `kind: "everything"` → "Download the rest as .m3u"
- `indexes.length < 2` → no button at all, which is stricter than today's "there is a next
  row" test and correct: from the last episode of a season there is a next *file* (an extra)
  but no rest of the season.

`player.ts` renders whatever it is handed and decides nothing.

## Testing

Every item below is a test written before the change it covers.

| Test | What it pins |
| --- | --- |
| `src/util/playlistTitle.test.ts` | `Kepler.S02E04.1080p.WEB-DL.mkv` → `Kepler S02E04`, with no `1080p` in it; a Sonarr-shaped name → `Kepler S02E04 · Ashfall Rising`; `Harrowgate.S03.1080p.WEB-DL.mkv` (season, no episode) → `Harrowgate`; `Kestrel.2010.1080p.BluRay.x264.mkv` → `Kestrel 2010`; a bonus-style `Harrowgate.S03/Bonus_Gag_Reel_1.mkv` → `Bonus Gag Reel 1`, with no directory in it; a filename carrying `\r\n`, a leading `#`, and a control character → all stripped; a 300-character name → capped at 120; a name that sanitises to nothing → `stream` |
| `src/util/restPlaylist.test.ts` | from an episode, later episodes of the same season only, with a bonus file that names a season but no episode excluded; a second season excluded; from an extra, `kind: "everything"` and the sorted slice; from a season pack (season, no episode) → `everything`; from a film → a single index; an out-of-range index → `[index]`; the last episode of a season → one index, so no button; an extra named `S03E02.Deleted.Scenes` IS included, recording the no-dedupe choice |
| `src/web/stream.test.ts` | the playlist body starts `#EXTM3U` and carries one `#EXTINF:-1,<title>` per URL; a filename containing a newline cannot add a line to the body (count the URLs); `Content-Length` matches the new body; **every entry names the request's `Host`, for a non-video file** — the regression guard for the report above; `?rest=1` from an episode lists that season only |
| `src/web/static/upNext.test.ts` | the label for each `kind`; absent when one entry |
| `src/web/static/playerModel.test.ts` | `vlcLinks(url, "macos")` is `[]`; `ios` and `android` unchanged; `detectPlatform` still returns `macos` for a Mac UA; `interruptedNotice` names no button that desktop lacks |
| `src/web/static/copyText.test.ts` | arrives with the cherry-pick |

Fixtures use the repo's cast (`Kepler`, `Harrowgate`, `Kestrel`, `Tin.Rivers`) and never a real
title. Note the trap CLAUDE.md records: `playlistTitle` tests assert on *substrings* of fixture
names, so a future rename must re-check them.

Then `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` — the last being the only
thing that proves `playlistTitle.ts` and `restPlaylist.ts` stay browser-safe, since
`upNext.ts` bundles them.

## Both front ends

The `.m3u` is built server-side, so playlist titles and the season rule reach the terminal UI
and the browser at once — the TUI's `.m3u` is the same route.

The other two are browser-only and qualify under CLAUDE.md's "a surface can't express it": the
terminal has no clipboard button and no VLC link, because `src/util/player.ts` launches the
user's player directly. Nothing in the TUI changes.

## Documentation

- `README.md` line ~311: "On iOS and Android you also get a direct VLC link" is already
  accurate for the new behaviour, but the paragraph implies desktop has one too. Reword to say
  desktop hands the `.m3u` to whatever plays video, and that VLC on the desktop registers no
  URL scheme for a page to link to.
- `README.md` line ~322: "Download rest of season" gains the same-season definition and the
  bonus-material case.
- The web UI's limitations list gets no new entry: nothing here is a limitation, and the copy
  button's insecure-origin caveat stops being one.
