# Player Page Hand-Off Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four ways out of the browser player — copy the URL, open VLC, download a `.m3u`, download the rest of the season — actually work and say what they do.

**Architecture:** Two new pure modules in `src/util/` (`playlistTitle.ts`, `restPlaylist.ts`) that the server's `.m3u` route and the browser's player page both consume, so the rule for "which files, and what they are called" has one implementation. One cherry-pick. Two small edits to existing decision modules (`playerModel.ts`, `upNext.ts`). `player.ts` and `stream.ts` gain no new conditionals of their own.

**Tech Stack:** TypeScript, Node 20+, vitest, tsup (browser bundle for `src/web/static/`), Ink/React (untouched here).

**Spec:** `docs/superpowers/specs/2026-08-01-web-player-handoff-design.md`

## Global Constraints

- **Never name a real film or show** in a test, fixture, doc comment, example or user-facing copy. Reuse the repo's cast: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **`src/util/` must stay browser-safe**: no `node:*` import may appear in `playlistTitle.ts` or `restPlaylist.ts`, or in anything they reach. `npm run build` is the enforcement, not grep.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML`** anywhere in `src/web/static/`. Every node is `createElement` + `textContent`.
- **`src/web` must not import from `src/ui`**; `src/core` must not import from either. Share by moving helpers down into `src/util/`.
- **Decisions live in pure modules**, never in `app.ts` or `player.ts`. A conditional that decides what to show or what to send belongs in a tested module.
- Conventional Commits. Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Before declaring done: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) is expected — leave it.
- Branch: `worktree-enumerated-dazzling-scott`, based on `main` at `3891cd8`. Do not `cd` out of this worktree.

## File Structure

| File | Responsibility |
| --- | --- |
| Create `src/util/playlistTitle.ts` | One filename → one `#EXTINF` title. Sanitising and derivation, nothing else. |
| Create `src/util/playlistTitle.test.ts` | Its tests. |
| Create `src/util/restPlaylist.ts` | Which session indexes a "rest" playlist contains, and which kind it is. |
| Create `src/util/restPlaylist.test.ts` | Its tests. |
| Create `src/web/static/copyText.ts` + `.test.ts` | Arrives via cherry-pick. Clipboard routes. |
| Modify `src/web/stream.ts` | The `.m3u` body: `#EXTM3U`, `#EXTINF` per entry, indexes from `restPlaylist`. Delete the local `restOfSession`. |
| Modify `src/web/stream.test.ts` | Body assertions now read URL lines, not the whole body. Two policy tests rewritten. |
| Modify `src/web/static/playerModel.ts` | `vlcLinks` offers nothing on macOS. `interruptedNotice` stops naming VLC. |
| Modify `src/web/static/upNext.ts` | `UpNextView.restLabel` — the button's text, or null. |
| Modify `src/web/static/player.ts` | Renders `restLabel`. Wiring only. Plus the cherry-pick's copy wiring. |
| Modify `README.md` | The desktop VLC paragraph, and the rest-of-season definition. |

---

### Task 1: The copy button copies on an insecure origin

Cherry-pick, not a rewrite: this work exists and is already tested.

**Files:**
- Create (by cherry-pick): `src/web/static/copyText.ts`, `src/web/static/copyText.test.ts`
- Modify (by cherry-pick): `src/web/static/player.ts`, `src/web/static/styles.css`

**Interfaces:**
- Consumes: nothing.
- Produces: `copyText(text, ports): CopyOutcome | Promise<CopyOutcome>`, `copyNotice(outcome): string`, `clipboardPorts(): CopyPorts`, `type CopyOutcome = "copied" | "manual"` — all from `src/web/static/copyText.ts`. Task 6 edits the same region of `player.ts`, so this task must land first.

- [ ] **Step 1: Confirm the commit is the one intended, and that it is only the copy fix**

```bash
git log --oneline -2 copy-stream-url-on-insecure-origins
# aeb28b8 docs: design for subtitle support        <- DO NOT take this one
# 2e6ba39 fix(web): copy the stream URL on an insecure origin
git show --stat 2e6ba39
```

Expected: `2e6ba39` touches exactly `src/web/static/copyText.ts`, `src/web/static/copyText.test.ts`, `src/web/static/player.ts`, `src/web/static/styles.css`. If it touches anything else, stop and report.

- [ ] **Step 2: Cherry-pick it**

```bash
git cherry-pick 2e6ba39
```

Expected: clean. If it conflicts in `player.ts`, resolve by keeping *both* sides' intent — the incoming `copyText` call replaces the old `navigator.clipboard` block inside the `"Copy stream URL"` button, and everything else in the file stays.

- [ ] **Step 3: Run its tests**

Run: `npx vitest run src/web/static/copyText.test.ts`
Expected: PASS.

- [ ] **Step 4: Verify the old dead-end message is gone**

Run: `grep -rn "needs a secure context" src/`
Expected: no matches. If one remains, the cherry-pick's `player.ts` hunk did not apply — fix `player.ts` so the button calls `copyText(stream, clipboardPorts())` and reports through `copyNotice`, and reveals the manual field on `"manual"`.

- [ ] **Step 5: Full suite, then stop**

Run: `npm test`
Expected: PASS. The cherry-pick is already committed by `git cherry-pick`; nothing to commit here.

---

### Task 2: No dead VLC button on the desktop

**Files:**
- Modify: `src/web/static/playerModel.ts` — `vlcLinks` (~line 221), `interruptedNotice` (~line 325)
- Test: `src/web/static/playerModel.test.ts` — the `vlcLinks` describe block (~line 224)

**Interfaces:**
- Consumes: `type Platform = "ios" | "android" | "macos" | "other"` and `ExternalLink` from `playerModel.ts`, both unchanged.
- Produces: `vlcLinks(absolute: string, platform: Platform): ExternalLink[]` — same signature, now `[]` for `"macos"`. `detectPlatform` is unchanged and still returns `"macos"`.

- [ ] **Step 1: Write the failing tests**

In `src/web/static/playerModel.test.ts`, **replace** the existing `it("offers the x-callback scheme on iOS and macOS", …)` with these two, and **replace** the existing `it("offers nothing on other platforms", …)` with the third:

```ts
  it("offers the x-callback scheme on iOS", () => {
    expect(vlcLinks(url, "ios")).toEqual([
      {
        id: "vlc-callback",
        label: "Open in VLC",
        href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`,
      },
    ]);
  });

  /**
   * macOS was given the iOS app's scheme, and the click was a silent no-op.
   * Verified against a real install: VLC.app's Info.plist registers http, https,
   * ftp, mms, mmsh, rtsp, udp, rtp, rtmp*, sftp and smb — no `vlc://` and no
   * `vlc-x-callback://`. There is nothing for a page to link to, so the desktop
   * gets the `.m3u`, which works, and no button that does nothing.
   */
  it("offers nothing on desktop, macOS included", () => {
    for (const platform of ["macos", "other"] as const) {
      expect(vlcLinks(url, platform)).toEqual([]);
    }
  });

  // The platform is still detected; only what we offer it changed.
  it("still recognises a Mac", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
  });
```

Then add, in the file's `interruptedNotice` describe block (or a new one at the end of the file if there is none):

```ts
describe("interruptedNotice", () => {
  // Desktop has no VLC button any more, so naming one is naming a control that
  // is not on screen.
  it.each(["stall", "error"] as const)("names no button the desktop lacks (%s)", (reason) => {
    expect(interruptedNotice(reason)).not.toContain("VLC");
    expect(interruptedNotice(reason)).toContain(".m3u");
  });
});
```

Make sure `interruptedNotice` and `detectPlatform` are in the file's import list from `./playerModel`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/web/static/playerModel.test.ts`
Expected: FAIL — `vlcLinks(url, "macos")` returns the callback link, and `interruptedNotice` contains "VLC".

- [ ] **Step 3: Make macOS offer nothing**

In `src/web/static/playerModel.ts`, change `vlcLinks` and its doc comment:

```ts
/**
 * The "open in VLC" links that can actually work on this platform.
 *
 * Empty on every desktop — Windows, Linux and macOS — and that is the point:
 * none of them registers a VLC URL scheme, so a button there is a button that
 * does nothing. macOS was in the iOS branch and was exactly that bug: VLC.app's
 * Info.plist registers http, https, ftp, mms, mmsh, rtsp, udp, rtp, rtmp*, sftp
 * and smb, and `vlc-x-callback://` belongs to the iOS app alone, so the click
 * went nowhere with nothing on screen to say why. Desktop gets the `.m3u`
 * download, which does work, and is not told to use VLC — it may not be what
 * they play video in.
 */
export function vlcLinks(absolute: string, platform: Platform): ExternalLink[] {
  if (platform === "ios") {
    return [
      {
        id: "vlc-callback",
        label: "Open in VLC",
        href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(absolute)}`,
      },
    ];
  }
  if (platform === "android") {
    const href = androidIntent(absolute);
    return href ? [{ id: "vlc-intent", label: "Open in VLC", href }] : [];
  }
  return [];
}
```

- [ ] **Step 4: Stop telling desktop users to open VLC**

Replace the two return strings in `interruptedNotice`:

```ts
export function interruptedNotice(reason: FallbackReason): string {
  if (reason === "stall") {
    return "Playback stopped — no more of the stream arrived. Download the .m3u and carry on watching there.";
  }
  return "Playback stopped partway through — the stream failed upstream. Download the .m3u and carry on watching there.";
}
```

Also update that function's doc comment, whose last paragraph says both branches "point at the `.m3u` and VLC, because those buttons are still on screen" — only the `.m3u` is, on a desktop.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/web/static/playerModel.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/static/playerModel.ts src/web/static/playerModel.test.ts
git commit -m "$(printf 'fix(web): stop offering macOS a VLC scheme it has never registered\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 3: `playlistTitle` — what an entry is called

**Files:**
- Create: `src/util/playlistTitle.ts`
- Test: `src/util/playlistTitle.test.ts`

**Interfaces:**
- Consumes: `parseRelease(name: string): ParsedRelease | null` from `src/util/release.ts`. Verified behaviour, relied on below: `Kepler (2019) - S02E04 - … .mkv` → `{title: "Kepler", season: 2, episode: 4}`; `Harrowgate.S03/Bonus_Gag_Reel_1.mkv` → `{title: "Harrowgate", season: 3, episode: undefined}`; `Kestrel.2010….mkv` → `{title: "Kestrel", year: 2010}`.
- Produces: `playlistTitle(filename: string): string` — never empty, never contains CR, LF or a control character, at most 120 characters. Used by Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/util/playlistTitle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { playlistTitle } from "./playlistTitle";

describe("playlistTitle", () => {
  it("names an episode by its show and tag, without the release junk", () => {
    expect(playlistTitle("Harrowgate.S03E01.1080p.WEB-DL.mkv")).toBe("Harrowgate S03E01");
  });

  /**
   * The Sonarr/Plex shape, which is the one that actually carries an episode
   * name. The spaced dash is what marks it as a name rather than release junk.
   */
  it("keeps a spaced-dash episode name", () => {
    expect(
      playlistTitle("Kepler (2019) - S02E04 - Ashfall Rising (1080p BluRay x265 GROUP).mkv"),
    ).toBe("Kepler S02E04 · Ashfall Rising");
  });

  it("does not mistake dot-delimited junk for an episode name", () => {
    const title = playlistTitle("Kepler.S02E04.1080p.WEB-DL.mkv");
    expect(title).toBe("Kepler S02E04");
    expect(title).not.toContain("1080p");
  });

  it("carries a multi-episode tag whole", () => {
    expect(playlistTitle("Harrowgate.S03E01E02.1080p.WEB-DL.mkv")).toBe("Harrowgate S03E01E02");
  });

  it("names a film by title and year", () => {
    expect(playlistTitle("Kestrel.2010.1080p.BluRay.x264.mkv")).toBe("Kestrel 2010");
  });

  it("names a season pack that commits to no episode by its title", () => {
    expect(playlistTitle("Harrowgate.S03.1080p.WEB-DL.mkv")).toBe("Harrowgate");
  });

  /**
   * The case that started this: a bonus feature in a season pack. The directory
   * is dropped — a playlist row reading "Harrowgate.S03/" tells you nothing —
   * and the underscores become spaces.
   */
  it("reads a bonus feature as its own name, without the directory", () => {
    const title = playlistTitle("Harrowgate.S03/Bonus_Gag_Reel_1.mkv");
    expect(title).toBe("Bonus Gag Reel 1");
    expect(title).not.toContain("/");
  });

  /**
   * THE SECURITY CASE. A filename comes from whoever made the torrent, and this
   * string is written into a file another application parses line by line. A
   * newline would let it ADD AN ENTRY pointing anywhere it liked.
   */
  it("strips every character that could add or forge a line", () => {
    const title = playlistTitle("evil\r\nhttp://attacker.example/x\nmore.mkv");
    expect(title).not.toContain("\n");
    expect(title).not.toContain("\r");
    expect(title).not.toContain("attacker.example/x\n");
  });

  it("cannot pose as a playlist directive", () => {
    expect(playlistTitle("#EXTINF:-1,nope.mkv").startsWith("#")).toBe(false);
  });

  it("strips control characters", () => {
    expect(playlistTitle("a\u0007b\u009fc.mkv")).toBe("abc");
  });

  it("caps the length", () => {
    expect(playlistTitle(`${"a".repeat(300)}.mkv`).length).toBe(120);
  });

  it("keeps commas, which #EXTINF allows after the first one", () => {
    expect(playlistTitle("Kepler (2019) - S02E04 - Ashfall, Rising.mkv")).toBe(
      "Kepler S02E04 · Ashfall, Rising",
    );
  });

  it("never returns an empty title", () => {
    for (const name of ["", ".mkv", "###", "\u0000\u0001"]) {
      expect(playlistTitle(name)).toBe("stream");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/util/playlistTitle.test.ts`
Expected: FAIL — `Cannot find module './playlistTitle'`.

- [ ] **Step 3: Write the implementation**

Create `src/util/playlistTitle.ts`:

```ts
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
 * It lives in `src/util/` because the server builds the playlist body and
 * `parseRelease` already lives here. Browser-safe: no `node:*`, directly or
 * transitively — `npm run build` is the enforcement.
 */
import { parseRelease } from "./release";

/** `#EXTINF` is one line; a label longer than this is not helping anyone. */
const MAX = 120;

/** C0 and C1, which covers CR, LF, NUL and every terminal escape. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * `S03E01`, and `S03E01E02` for a double bill. Case-insensitive because
 * releases write it every way, and normalised to upper case on the way out so a
 * playlist does not mix `s03e01` and `S03E02` rows.
 */
const TAG = /S(\d{1,2})E\d{1,3}(?:E\d{1,3})*/i;

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
    const show = parseRelease(base)?.title ?? "";
    const label = [show, tag[0].toUpperCase()].filter(Boolean).join(" ");
    const name = episodeName(base.slice(tag.index + tag[0].length));
    return clamp(sanitise(name ? `${label} · ${name}` : label)) || fallback(base);
  }
  const parsed = parseRelease(base);
  const named = parsed ? [parsed.title, parsed.year].filter(Boolean).join(" ") : "";
  return clamp(sanitise(named || spaced(base))) || fallback(base);
}

/** The filename alone, no directory and no extension. */
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
 * Everything that must not reach the file. Note the order: controls go first,
 * so a `#` hidden behind a stripped character cannot end up leading the line.
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/util/playlistTitle.test.ts`
Expected: PASS. If the multi-episode or bonus case fails, fix the implementation to match the test — the test is the spec. Do not weaken an assertion to make it pass; if you believe a test is wrong, stop and report which and why.

- [ ] **Step 5: Commit**

```bash
git add src/util/playlistTitle.ts src/util/playlistTitle.test.ts
git commit -m "$(printf 'feat(util): derive a safe .m3u entry title from a filename\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 4: `restPlaylist` — which files "the rest" means

**Files:**
- Create: `src/util/restPlaylist.ts`
- Test: `src/util/restPlaylist.test.ts`

**Interfaces:**
- Consumes: `sortStreamFiles(files, "name")` from `src/util/streamFileSort.ts`; `streamCandidates(files)` and `type SizedFile` from `src/util/videoFiles.ts`; `parseRelease` from `src/util/release.ts`; `type EpisodeRef` from `src/util/episode.ts`.
- Produces, all from `src/util/restPlaylist.ts`, used by Tasks 5 and 6:

```ts
export type RestKind = "season" | "everything";
export interface RestPlaylist {
  kind: RestKind;
  indexes: number[];
}
export interface IndexedFile extends SizedFile {
  index: number;
}
export function restPlaylist<T extends IndexedFile>(
  files: readonly T[],
  index: number,
): RestPlaylist;
```

- [ ] **Step 1: Write the failing test**

Create `src/util/restPlaylist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { restPlaylist, type IndexedFile } from "./restPlaylist";

function file(index: number, filename: string, bytes = 1024 ** 3): IndexedFile {
  return { index, filename, bytes };
}

/**
 * A season pack shaped like the one that prompted this: episodes named out of
 * order, a bonus feature that names the season but no episode, and a `.nfo` the
 * picker already drops.
 */
const PACK: IndexedFile[] = [
  file(0, "Harrowgate.S03E03.1080p.WEB-DL.mkv"),
  file(1, "Harrowgate.S03E01.1080p.WEB-DL.mkv"),
  file(2, "Harrowgate.S03/readme.nfo"),
  file(3, "Harrowgate.S03E02.1080p.WEB-DL.mkv"),
  file(4, "Harrowgate.S03/Bonus_Gag_Reel_1.mkv"),
];

describe("restPlaylist", () => {
  it("from an episode, plays the rest of that season", () => {
    expect(restPlaylist(PACK, 1)).toEqual({ kind: "season", indexes: [1, 3, 0] });
  });

  /**
   * THE BUG. Started from an episode, the old rule was "every later file in
   * name order", which swept the bonus feature into the season playlist.
   */
  it("leaves out a bonus feature that names no episode", () => {
    expect(restPlaylist(PACK, 1).indexes).not.toContain(4);
  });

  it("leaves out the non-video files the picker leaves out", () => {
    expect(restPlaylist(PACK, 1).indexes).not.toContain(2);
  });

  it("is one entry from the last episode of a season", () => {
    // Session index 0 is E03, which sorts last of the three episodes.
    expect(restPlaylist(PACK, 0)).toEqual({ kind: "season", indexes: [0] });
  });

  /**
   * From a bonus feature there is no season to be the rest of, so the meaning
   * falls back to "everything from here" — and the caller labels it that way.
   */
  it("from a bonus feature, takes everything from there on", () => {
    const out = restPlaylist(PACK, 4);
    expect(out.kind).toBe("everything");
    expect(out.indexes[0]).toBe(4);
    expect(out.indexes).toContain(1);
  });

  it("stops at the season boundary in a multi-season pack", () => {
    const two: IndexedFile[] = [
      file(0, "Kepler.S01E01.1080p.WEB-DL.mkv"),
      file(1, "Kepler.S01E02.1080p.WEB-DL.mkv"),
      file(2, "Kepler.S02E01.1080p.WEB-DL.mkv"),
    ];
    expect(restPlaylist(two, 0)).toEqual({ kind: "season", indexes: [0, 1] });
  });

  it("is a single entry for a film", () => {
    const film = [file(0, "Kestrel.2010.1080p.BluRay.x264.mkv")];
    expect(restPlaylist(film, 0)).toEqual({ kind: "everything", indexes: [0] });
  });

  /**
   * A season pack file that names a season but no episode is not an episode, so
   * there is no season to continue — the same branch a bonus feature takes.
   */
  it("treats a file naming a season but no episode as everything", () => {
    const pack = [
      file(0, "Harrowgate.S03.1080p.WEB-DL.mkv"),
      file(1, "Harrowgate.S03.extras.mkv"),
    ];
    expect(restPlaylist(pack, 0).kind).toBe("everything");
  });

  it("falls back to just that index when it names no candidate", () => {
    expect(restPlaylist(PACK, 99)).toEqual({ kind: "everything", indexes: [99] });
    // The .nfo is not a candidate, so asking for it is the same case.
    expect(restPlaylist(PACK, 2)).toEqual({ kind: "everything", indexes: [2] });
  });

  /**
   * RECORDED CHOICE, not an oversight: an extra that poses as an episode stays
   * in. Deduplicating by episode number would drop it — and would equally drop
   * `S03E02.Part2` next to `S03E02.Part1`, which loses half an episode to tidy
   * up a duplicate. Including one extra is the cheaper mistake.
   */
  it("keeps an extra that names an episode of its own", () => {
    const posing: IndexedFile[] = [
      file(0, "Harrowgate.S03E01.1080p.WEB-DL.mkv"),
      file(1, "Harrowgate.S03E02.1080p.WEB-DL.mkv"),
      file(2, "Harrowgate.S03E02.Deleted.Scenes.mkv"),
    ];
    expect(restPlaylist(posing, 0).indexes).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/util/restPlaylist.test.ts`
Expected: FAIL — `Cannot find module './restPlaylist'`.

- [ ] **Step 3: Write the implementation**

Create `src/util/restPlaylist.ts`:

```ts
/**
 * Which files a "play on from here" playlist contains — the rule, shared.
 *
 * WHY IT IS HERE AND NOT IN `src/web/stream.ts`, where it started. Two surfaces
 * need the same answer: the server picks the files that go in the `.m3u`, and
 * the player page decides what the button is called and whether to show it at
 * all. Two implementations of one rule is the copy-then-drift bug this codebase
 * has recorded four times, so the rule is in one place and both call it.
 *
 * WHAT WAS WRONG WITH THE OLD RULE. "This file and every later one in name
 * order" is only accidentally right. Started from a bonus feature it yields
 * every remaining extra and then the whole season, under a button that says
 * "rest of season"; started from an episode it happens to be correct only while
 * the extras sort clear of the episodes, and a torrent naming one
 * `Show.S03E02.Deleted.Scenes` breaks that.
 *
 * Generic over the shape for the reason `sortStreamFiles` is: the server holds
 * `StreamFile` with an upstream `url`, the browser holds `PublicStreamFile` with
 * a `handle`, and each keeps the field that addresses its own file. Browser-safe:
 * no `node:*` here or in anything it reaches.
 */
import { parseRelease } from "./release";
import { sortStreamFiles } from "./streamFileSort";
import { streamCandidates, type SizedFile } from "./videoFiles";
import type { EpisodeRef } from "./episode";

/**
 * What the playlist turned out to mean. The caller words the button from this:
 * a season can be called a season, and anything else must not be.
 */
export type RestKind = "season" | "everything";

export interface RestPlaylist {
  kind: RestKind;
  /** Session indexes in play order, the current file first. Never empty. */
  indexes: number[];
}

/** A file that knows its own position in the session — the `:idx` of its handle. */
export interface IndexedFile extends SizedFile {
  index: number;
}

export function restPlaylist<T extends IndexedFile>(
  files: readonly T[],
  index: number,
): RestPlaylist {
  // The picker's order, and the episode list's: a playlist that ran E08, E02,
  // E03 is the bug `sortStreamFiles` was extracted to fix. `streamCandidates`
  // drops the `.nfo`s, because handing a text file to a media player is how a
  // playlist stalls halfway through a season.
  const ordered = sortStreamFiles(streamCandidates(files), "name");
  const at = ordered.findIndex((file) => file.index === index);
  // A hand-edited URL, or the index of a file the video filter removed. One
  // entry is honest: that file does exist and does play.
  if (at < 0) return { kind: "everything", indexes: [index] };

  const here = episodeOf(ordered[at]!.filename);
  const rest = ordered.slice(at);
  if (!here) return { kind: "everything", indexes: rest.map((file) => file.index) };

  // A season means files that name an episode OF THIS SEASON. The current file
  // is always in, whatever the filter would say about it.
  const indexes = rest
    .filter((file, offset) => {
      if (offset === 0) return true;
      const ep = episodeOf(file.filename);
      return ep !== null && ep.season === here.season;
    })
    .map((file) => file.index);
  return { kind: "season", indexes };
}

/**
 * The episode a filename commits to, or null.
 *
 * BOTH numbers are required. A season pack file and a bonus feature inside a
 * season folder both parse to a season with no episode, and treating that as
 * "episode 1 of that season" is what would sweep the extras back in.
 */
function episodeOf(filename: string): EpisodeRef | null {
  const parsed = parseRelease(filename);
  if (parsed?.season === undefined || parsed.episode === undefined) return null;
  return { season: parsed.season, episode: parsed.episode };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/util/restPlaylist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/restPlaylist.ts src/util/restPlaylist.test.ts
git commit -m "$(printf 'feat(util): define the rest-of-season playlist as one shared rule\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 5: The `.m3u` gains titles, and the right files

**Files:**
- Modify: `src/web/stream.ts` — imports (~lines 29-30), delete `restOfSession` (~lines 175-194), the `rep === "playlist"` branch (~lines 485-537)
- Test: `src/web/stream.test.ts` — several existing assertions, listed below

**Interfaces:**
- Consumes: `playlistTitle(filename)` (Task 3), `restPlaylist(files, index)` and `IndexedFile` (Task 4).
- Produces: a body of the form `#EXTM3U\n#EXTINF:-1,<title>\n<url>\n…`. Nothing else consumes it in code; the browser only links to it.

> **Read this before writing any test.** Several existing tests read the playlist body *as a single URL* (`res.body.trim()`) or assert `not.toContain("#EXTINF")`. Adding a header and titles makes those either fail or — worse — pass vacuously. CLAUDE.md records this exact trap: a negative assertion whose subject no longer appears anywhere still passes, and proves nothing. Every one is listed here; none may be deleted without a replacement.

- [ ] **Step 1: Add the test helper and update the tests that read the body as one URL**

In `src/web/stream.test.ts`, add near the top of the file (after the imports):

```ts
/**
 * The URL lines of a playlist body — everything that is not a directive.
 *
 * The body carries `#EXTM3U` and an `#EXTINF` per entry now, so a test that
 * wants the addresses has to say so. Assertions about what must NOT be in the
 * file (a Real-Debrid token, a forwarded host) stay on the WHOLE body, because
 * a leak into a title is just as much a leak.
 */
const urlsIn = (body: string): string[] =>
  body
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith("#"));
```

Then update these, all in `describe("GET /stream/:sid/:idx.m3u", …)` and the `.files`/`?rest=1` blocks (line numbers as of `af6123c`):

1. `it("serves a playlist whose one line is the absolute handle, capability included")` (~1457) — replace `const lines = res.body.trim().split("\n");` with `const lines = urlsIn(res.body);`. Keep every other assertion, and **add**:

```ts
    expect(res.body.startsWith("#EXTM3U\n")).toBe(true);
    expect(res.body).toContain("#EXTINF:-1,Copper Kettle Run");
    // The header the browser uses to size the download must still match.
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.body));
```

2. `it("is fetchable end to end — the URL inside it serves the bytes")` (~1477) — `fetch(playlist.body.trim())` becomes `fetch(urlsIn(playlist.body)[0]!)`.

3. The three `Host` tests — `it("builds the URL from the Host header")` / `it("ignores X-Forwarded-* by default")` / `it("honours X-Forwarded-* when trustProxy is on")` (~1521, ~1535, ~1547) — change `expect(res.body.trim()).toBe(<url>)` to `expect(urlsIn(res.body)).toEqual([<url>])`. Leave `expect(res.body).not.toContain("evil.example")` on the whole body.

4. `it("never writes a Real-Debrid link into the file")` (~1585) — same change to `urlsIn(res.body)`; keep both `not.toContain` assertions on the whole body.

5. `?rest=1` → `it("lists this file and every later one, in display order")` (~1303) — rename to `it("lists the rest of the season, in display order")` and read `urlsIn(await res.text())`.

6. `?rest=1` → `it("is just this file when it is the last one")` (~1318) and `it("is unchanged without the parameter")` (~1340) and `it("treats rest=0 as off")` (~1350) — replace `text.trim().split("\n")).toHaveLength(1)` with `urlsIn(text)).toHaveLength(1)`.

7. `?rest=1` → **delete** `it("still contains no filename at all")` (~1332) and put these two in its place. Deleting without replacing would drop a real policy check:

```ts
    /**
     * Titles are IN the body now, so the old "no filename anywhere" rule is
     * gone — but the rule it protected is not. A filename comes from whoever
     * made the torrent, and this file is parsed line by line by another
     * application, so a name must never be able to ADD a line.
     */
    it("cannot be given an extra entry by a filename", async () => {
      const { base, capability, id } = await packSession({
        files: [
          {
            url: "https://cdn.example/1",
            filename: "Harrowgate.S03E01\r\nhttp://attacker.example/x\n.mkv",
            bytes: 100,
          },
        ],
      });
      const text = await (await fetch(`${base}/stream/${id}/0.m3u?rest=1&k=${capability}`)).text();
      expect(urlsIn(text)).toEqual([
        `http://127.0.0.1:${new URL(base).port}/stream/${id}/0?k=${capability}`,
      ]);
      expect(text).not.toContain("attacker.example");
    });

    it("puts a title on every entry, and a URL under each", async () => {
      const { base, capability, id } = await packSession();
      const text = await (await fetch(`${base}/stream/${id}/1.m3u?rest=1&k=${capability}`)).text();
      const lines = text.trim().split("\n");
      expect(lines[0]).toBe("#EXTM3U");
      expect(lines.filter((l) => l.startsWith("#EXTINF:-1,"))).toHaveLength(urlsIn(text).length);
      expect(text).toContain("#EXTINF:-1,Harrowgate S03E01");
      expect(text).toContain("#EXTINF:-1,Harrowgate S03E02");
    });
```

8. Add, in the same `?rest=1` block, the two tests for the new file rule and the reported host:

```ts
    /**
     * A bonus feature names the season but no episode, so it is not part of the
     * season and must not be swept into its playlist.
     */
    it("leaves a bonus feature out of a season", async () => {
      const { base, capability, id } = await packSession({
        files: [
          {
            url: "https://cdn.example/1",
            filename: "Harrowgate.S03E01.1080p.WEB-DL.mkv",
            bytes: 100,
          },
          {
            url: "https://cdn.example/bonus",
            filename: "Harrowgate.S03/Bonus_Gag_Reel_1.mkv",
            bytes: 50,
          },
        ],
      });
      const text = await (await fetch(`${base}/stream/${id}/0.m3u?rest=1&k=${capability}`)).text();
      expect(urlsIn(text)).toHaveLength(1);
      expect(text).not.toContain("Gag Reel");
    });

    /**
     * REGRESSION GUARD for a report of a playlist naming 127.0.0.1. It turned
     * out to be a second server on another port, not a defect — every entry has
     * always come from the request's own Host. This pins that for a NON-VIDEO
     * file, which is the case the report was about, so no future refactor can
     * introduce a per-file origin.
     */
    it("names the request's own host, for a non-video file too", async () => {
      const { port, capability, id } = await bonusSession();
      const res = await rawGet(port, `/stream/${id}/0.m3u?rest=1&k=${capability}`, {
        Host: "nas.lan:9162",
      });
      for (const url of urlsIn(res.body)) {
        expect(url.startsWith("http://nas.lan:9162/stream/")).toBe(true);
      }
      expect(res.body).not.toContain("127.0.0.1");
    });
```

For that last one, add a fixture next to `packSession` in the same describe block — a session whose only files are non-video, so `streamCandidates` falls back to all of them:

```ts
  /** A session of nothing that looks like video — the `streamCandidates` fallback. */
  async function bonusSession(): Promise<{ port: number; capability: string; id: string }> {
    const { base, capability, id } = await packSession({
      files: [
        { url: "https://cdn.example/a", filename: "disc.bin", bytes: 9 },
        { url: "https://cdn.example/b", filename: "extras.bin", bytes: 8 },
      ],
    });
    return { port: Number(new URL(base).port), capability, id };
  }
```

If `rawGet` is not in scope in that describe block, use `fetch` with a `Host` header instead — Node's `fetch` forbids setting `Host`, so in that case move this one test into the `describe("GET /stream/:sid/:idx.m3u", …)` block where `rawGet` and `ready()` already live, and build its session there.

- [ ] **Step 2: Run to verify the new and changed tests fail**

Run: `npx vitest run src/web/stream.test.ts`
Expected: FAIL — no `#EXTM3U` in the body, no `#EXTINF` lines, and the bonus feature still present in the season playlist.

- [ ] **Step 3: Rewrite the playlist branch**

In `src/web/stream.ts`:

(a) Imports — **remove** `import { sortStreamFiles } from "../util/streamFileSort";` and **add** the two new ones. Keep `streamCandidates`: the `.files` route at ~line 390 still uses it.

```ts
import { streamCandidates } from "../util/videoFiles";
import { playlistTitle } from "../util/playlistTitle";
import { restPlaylist } from "../util/restPlaylist";
```

(b) Delete the local `restOfSession` function and its doc comment entirely (~lines 175-194). `src/util/restPlaylist.ts` replaces it.

(c) Replace the body-building part of the `rep === "playlist"` branch. Everything above `const wantsRest` — the origin guard and `handleUrl` — stays exactly as it is.

```ts
    // `?rest=1` — this file and the rest of its season, so a season plays
    // unattended rather than one download per episode. A PARAMETER on the
    // existing representation rather than a route of its own: the guards above,
    // the origin check, and the body rules below all apply unchanged, and a
    // second playlist route would be a second place to forget one of them.
    //
    // Which files that means is `restPlaylist`, in `src/util/`, because the
    // player page needs the same answer to word its button — and two copies of
    // that rule is the copy-then-drift bug this codebase keeps recording.
    const wantsRest = (query.get("rest") ?? "") === "1";
    const indexes = wantsRest
      ? restPlaylist(
          session.files.map((f, index) => ({ ...f, index })),
          parsed.index,
        ).indexes
      : [parsed.index];

    // `#EXTINF` titles, and note what makes them safe rather than what makes
    // them nice: a filename comes from whoever made the torrent, and this file
    // is parsed line by line by another application. `playlistTitle` strips CR,
    // LF and every control character, so a name cannot ADD an entry pointing
    // wherever its author liked. It never returns "" either — an `#EXTINF:-1,`
    // with nothing after the comma is worse than no title.
    //
    // The URLs are still built from `streamHandle` and the origin, so nothing a
    // client put in the request reaches the body, and `file.url` — a debrid
    // credential — appears nowhere in it.
    const entries = indexes.map((index) => {
      const name = session.files[index]?.filename ?? "";
      return `#EXTINF:-1,${playlistTitle(name)}\n${handleUrl(index)}`;
    });
    const body = `#EXTM3U\n${entries.join("\n")}\n`;
```

The `res.writeHead` block below it is unchanged — `Content-Length` is computed from `body`, so it stays correct.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/web/stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Check nothing else read that body**

Run: `grep -rn "m3u" src --include=*.test.ts | grep -v "src/web/stream.test.ts" | grep -v m3u8`
Expected: no test outside `stream.test.ts` asserts on a playlist body. If one does, update it the same way.

- [ ] **Step 6: Commit**

```bash
git add src/web/stream.ts src/web/stream.test.ts
git commit -m "$(printf 'feat(web): title every .m3u entry, and make rest-of-season mean the season\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 6: The button says what it does, and only when it does something

**Files:**
- Modify: `src/web/static/upNext.ts` — `UpNextView` (~line 47), `upNextView` (~line 123)
- Modify: `src/web/static/player.ts` — `renderEpisodes` (~line 459)
- Test: `src/web/static/upNext.test.ts`

**Interfaces:**
- Consumes: `restPlaylist` and `RestKind` from `src/util/restPlaylist.ts` (Task 4). `PublicStreamFile` already has `index`, `filename` and `bytes`, so it satisfies `IndexedFile` with no mapping.
- Produces: `UpNextView.restLabel: string | null`. `player.ts` renders it and decides nothing.

- [ ] **Step 1: Write the failing test**

Add to `src/web/static/upNext.test.ts`:

```ts
describe("upNextView — the rest-of-season button", () => {
  it("offers the season by name from an episode with more to come", () => {
    expect(upNextView(HARROWGATE, SID, 1, CAP).restLabel).toBe("Download rest of season .m3u");
  });

  /**
   * From the last episode there is a next FILE in some torrents (an extra) but
   * no rest of the season, and a playlist of one file is the button already at
   * the top of the page.
   */
  it("offers nothing from the last episode of a season", () => {
    // Session index 0 is E03, which sorts last.
    expect(upNextView(HARROWGATE, SID, 0, CAP).restLabel).toBeNull();
  });

  /**
   * A bonus feature has no season to be the rest of. The playlist still means
   * something — everything from here — so the label says that instead of
   * promising a season it will not deliver.
   */
  it("does not call a bonus feature's playlist a season", () => {
    const withBonus: StreamFilesResponse = {
      ...HARROWGATE,
      files: [...HARROWGATE.files, file(4, "Harrowgate.S03/Bonus_Gag_Reel_1.mkv")],
    };
    expect(upNextView(withBonus, SID, 4, CAP).restLabel).toBe("Download the rest as .m3u");
  });

  it("offers nothing for a film", () => {
    expect(upNextView(KESTREL, SID, 0, CAP).restLabel).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/web/static/upNext.test.ts`
Expected: FAIL — `restLabel` does not exist on the returned object (and TypeScript will say so too).

- [ ] **Step 3: Add `restLabel` to the view**

In `src/web/static/upNext.ts`, add the import and the field:

```ts
import { restPlaylist, type RestKind } from "../../util/restPlaylist";
```

In the `UpNextView` interface:

```ts
  /**
   * The text for the "play on from here" download, or null for no button.
   *
   * HERE RATHER THAN IN `player.ts` because it is two decisions, and both are
   * the kind CLAUDE.md keeps out of the DOM-wiring files: whether a playlist of
   * this file onwards contains anything worth downloading, and whether it is
   * honest to call it a season. `restPlaylist` (src/util/restPlaylist.ts) is the
   * same function the server uses to pick the files, so the label and the file
   * cannot disagree.
   */
  restLabel: string | null;
```

At the top of the function, the single-file early return needs the field too:

```ts
  if (body.files.length < 2) return { rows: [], next: null, breadcrumb, restLabel: null };
```

And at the end, replace the final return:

```ts
  // A playlist of one file is the button that is already at the top of the page,
  // so one entry means no button. Note this is STRICTER than "there is a next
  // row": from the last episode of a season the next row may be an extra, and
  // the season is still over.
  const rest = restPlaylist(body.files, index);
  const restLabel = rest.indexes.length > 1 ? restLabelFor(rest.kind) : null;

  const at = rows.findIndex((row) => row.current);
  return { rows, next: at >= 0 ? (rows[at + 1] ?? null) : null, breadcrumb, restLabel };
```

And add the wording function next to it:

```ts
/**
 * What to call the playlist. "Rest of season" is a promise, and it is only true
 * when the file we started from named an episode — from a bonus feature the
 * playlist is everything from there on, and saying "season" would be a lie the
 * user only discovers in VLC.
 */
function restLabelFor(kind: RestKind): string {
  return kind === "season" ? "Download rest of season .m3u" : "Download the rest as .m3u";
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/web/static/upNext.test.ts`
Expected: PASS.

- [ ] **Step 5: Render it, and nothing else**

In `src/web/static/player.ts`, inside `renderEpisodes`, the button is currently appended inside `if (view.next)`. Move it out, so it follows `restLabel` alone:

```ts
  const nodes: HTMLElement[] = [];
  // "Up next" sits ABOVE the full list on purpose: it is the one action this
  // page exists to offer, and it must not depend on scrolling past sixty rows.
  if (view.next) nodes.push(listHeading("up next"), episodeRow(view.next));
  // Appended rather than built with the other controls because it depends on
  // `.files`, which lands after the first paint. Whether to show it and what to
  // call it are `upNextView`'s answers, not this file's.
  if (view.restLabel !== null) {
    actions.append(
      linkButton(view.restLabel, absoluteUrl(location.origin, restPlaylistPath(target))),
    );
  }
```

- [ ] **Step 6: Verify no decision leaked into the wiring**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Then confirm by eye that `player.ts` contains no `kind ===`, no `"season"` string and no `.length > 1` test around that block — if it does, the decision belongs in `upNext.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/web/static/upNext.ts src/web/static/upNext.test.ts src/web/static/player.ts
git commit -m "$(printf 'fix(web): only promise the rest of a season when there is one\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 7: Documentation, and the whole suite

**Files:**
- Modify: `README.md` (~line 310 and ~line 322)

**Interfaces:**
- Consumes: everything above. Produces: nothing in code.

- [ ] **Step 1: Fix the desktop VLC claim**

`README.md` ~line 310 currently ends: "…your OS hands that tiny playlist to VLC (or whatever your default player is) and it plays there. On iOS and Android you also get a direct VLC link."

Replace that last sentence with:

```markdown
  card naming the part your browser can't handle, plus a **Download .m3u** button: your OS hands that tiny
  playlist to VLC (or whatever your default player is) and it plays there. On iOS and Android there's also
  a direct **Open in VLC** button, because those apps register a URL scheme a web page can link to.
  Desktop VLC registers none — not on macOS, Windows or Linux — so there's no button to offer there, and
  the `.m3u` is the route that actually works.
```

- [ ] **Step 2: Say what "rest of season" now means**

`README.md` ~line 322 currently reads: "There is also **Download rest of season .m3u**, which is one playlist containing this episode and every later one in order — hand it to VLC once and it runs the rest of the season unattended."

Replace with:

```markdown
There is also **Download rest of season .m3u**, which is one playlist containing this episode and every
later one *of the same season* — hand it to VLC once and it runs the rest of the season unattended.
Bonus features and extras are left out, so a gag reel can't interrupt episode four. Every entry is
titled, so a thirteen-episode playlist reads as episodes rather than as thirteen identical URLs. Start
from a bonus feature instead and the button says **Download the rest as .m3u**, because there is no
season there to be the rest of.
```

- [ ] **Step 3: Check the web UI's limitations list is still true**

Run: `grep -n "clipboard\|secure context\|copy" README.md | head -20`
Expected: if any line says copying needs a secure context or is unavailable over a LAN, it is now false — remove or reword it. If there is no such line, nothing to do.

- [ ] **Step 4: Run every gate**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all pass. `npm run lint` shows exactly one pre-existing warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it. `npm run build` is the only check that `playlistTitle.ts` and `restPlaylist.ts` are browser-safe, since `upNext.ts` bundles them; a `node:*` reached transitively fails here and nowhere else.

- [ ] **Step 5: Run it and look at it**

```bash
npm run dev -- serve --web
```

Open the dashboard, play an episode of a multi-file torrent, and confirm by eye:
1. **Copy stream URL** copies over `http://<lan-ip>:9161` — or reveals a field with the URL selected. It must not say "needs a secure context".
2. There is no **Open in VLC** button on the desktop.
3. **Download rest of season .m3u** is present on an episode; open the file in a text editor and check each entry has an `#EXTINF` title and a URL naming the host you browsed.
4. Open a bonus feature: the button reads **Download the rest as .m3u**.
5. Open the last episode of the season: there is no rest-of-season button.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "$(printf 'docs: what the player page hands off, and to what\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

## Notes for whoever executes this

- **Task order matters in one place only:** Task 1 must precede Task 6, because both edit `player.ts`. Tasks 3 and 4 are independent of each other and of Task 2.
- **The tests are the specification.** If an assertion looks wrong, stop and say which and why rather than adjusting it to match the code. Two of them (`not.toContain("attacker.example")`, `not.toContain("127.0.0.1")`) are the kind that pass vacuously if the fixture they name drifts — if you change a fixture, re-check that the string still names something the test puts in play.
- **Nothing in the terminal UI changes.** The `.m3u` is built server-side, so titles and the season rule reach both front ends at once; the copy button and the VLC link are browser-only because the terminal launches the user's player directly (`src/util/player.ts`). That is the CLAUDE.md "a surface can't express it" exception, and the PR body should say so.
