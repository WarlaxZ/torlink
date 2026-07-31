# Web Player: Classification and Provider Transcode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web player classify a file by its real codecs instead of its file extension, and play what the debrid provider will transcode for us — rungs 1, 2 and 4 of the source ladder in `docs/superpowers/specs/2026-07-31-web-player-hard-containers-design.md`.

**Architecture:** A new capability-authenticated representation of the existing stream handle, `/stream/:sid/:idx.info?k=…`, answers "what is this file and how should you play it" in one JSON round trip. The server builds that answer from `ffprobe` when the binary is present and from the release name when it isn't, and includes a provider HLS manifest URL when the debrid provider will produce one. The player page reads it and picks a rung. Every decision is a pure function in `src/util/` or `playerModel.ts`; `player.ts` stays DOM wiring.

**Tech Stack:** TypeScript, Node 22+, vitest, tsup (two builds), hls.js (new browser-only dependency), `ffprobe` (detected, never required).

**Not in this plan:** rung 3, the local `ffmpeg` HLS path for the WebTorrent backend. That is a separate subsystem — child-process lifecycle, temp segment directories, a new route family — and it gets its own plan, `2026-07-31-web-player-local-hls.md`. This plan leaves the torrent backend on rung 4 exactly as it is today, which is a smaller improvement but not a regression.

## Global Constraints

Every task's requirements implicitly include all of these.

- **`src/web` must not import from `src/ui`; `src/core` must not import from `src/ui` or `src/web`.** Enforced by `eslint.config.js`. Share by moving the piece down into `src/util/` or `src/core/`.
- **When a second consumer appears, move the helper down rather than copying it.** This codebase records four bugs caused by copy-then-drift.
- **No `innerHTML` / `insertAdjacentHTML` / `document.write` / `outerHTML` anywhere in `src/web/static/`.** Every node is `createElement` + `textContent`. Filenames come from whoever uploaded a torrent; an `innerHTML` path is stored XSS.
- **No `node:*` imports reachable from `src/web/static/`.** `npm run build` is the only check for this — `platform: "browser"` in `tsup.web.config.ts` follows transitive imports where a grep cannot.
- **Anything deciding *what to show* or *what to send* lives in a pure module, not in `player.ts` or `app.ts`.** There is no jsdom in this repo, deliberately.
- **A new browser dependency needs an entry in `noExternal` in `tsup.web.config.ts`.** tsup treats `dependencies` as external, which for a browser bundle silently emits a bare specifier no browser can resolve; the build reports success and the page dies. Nothing in the test suite can see this.
- **Test fixtures name invented films and shows, never real ones.** Reuse this cast: `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **Fail soft when a binary is absent.** No `ffprobe` means classification falls back to the release name, never an error and never a crash.
- **No new runtime npm dependency other than hls.js.** `ffprobe` is detected on the host; nothing is downloaded in `postinstall`.
- **Never log a debrid unrestricted link or a capability.** Both are credentials. `handleStreamRequest`'s contract is that the caller logs the path only.
- **Before saying a task is done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. There is one known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) — leave it.
- **Conventional Commits.**

---

### Task 0: Verify the provider transcode endpoint and its CORS headers

This task writes no code and it gates Task 7 onward. The design rests on two things I have not measured: that Real-Debrid's `GET /streaming/transcode/{id}` returns HLS manifest URLs for an unrestricted file, and that those manifests and their segments are fetchable cross-origin. hls.js fetches both over XHR from our page's origin, so without `Access-Control-Allow-Origin` rung 2 cannot work as designed.

**Files:** none. Record findings in this file under Task 0 and commit.

**Requires:** a real Real-Debrid account and API token. If you do not have one, stop and hand this task back — do not implement Task 7 on the assumption that the answer is yes.

- [ ] **Step 1: Unrestrict a link and capture the download id**

```bash
export RD=<your-real-debrid-api-token>
# LINK is any hoster link RD will unrestrict; the easiest source is a magnet
# already added to your account, via GET /torrents/info/{id} -> .links[0]
curl -s -X POST https://api.real-debrid.com/rest/1.0/unrestrict/link \
  -H "Authorization: Bearer $RD" \
  --data-urlencode "link=$LINK" | jq '{id, filename, mimeType, streamable}'
```

Expected: an object with an `id` (a short alphanumeric string) and `streamable: 1`. `streamable: 0` means RD will not transcode this file — note that, because it is the case `transcodeManifest` must return `null` for.

- [ ] **Step 2: Ask for the transcode manifests**

```bash
curl -s "https://api.real-debrid.com/rest/1.0/streaming/transcode/$ID" \
  -H "Authorization: Bearer $RD" | jq .
```

Record the exact response shape verbatim in this file. Expected to be an object keyed by delivery format (`apple`, `dash`, `liveMP4`, `h264WebM` are the documented keys) whose values are objects mapping a quality label to a URL. Note which key carries an `.m3u8` and what the quality labels actually are.

- [ ] **Step 3: Check CORS on the manifest**

```bash
curl -sI "$MANIFEST_URL" | grep -i "access-control-allow-origin\|content-type\|^HTTP"
```

- [ ] **Step 4: Check CORS on a segment**

```bash
curl -s "$MANIFEST_URL" | grep -v '^#' | head -1   # a segment or a variant playlist URL
curl -sI "$SEGMENT_URL" | grep -i "access-control-allow-origin\|^HTTP"
```

A variant playlist at this level means it is a master playlist; follow it one more level to reach a real segment and check that.

**FINDINGS, measured 2026-07-31 against a live Real-Debrid account. Verdict: both present — proceed.**

- `POST /unrestrict/link` returns `id`, and also `streamable` (`1`/`0`) and `mimeType`. Response keys in full: `id,filename,mimeType,filesize,link,host,host_icon,chunks,crc,download,streamable`.
- `GET /streaming/transcode/{id}` → `200` with keys `apple`, `dash`, `liveMP4`, `h264WebM`. `apple` carries the `.m3u8`.
- **CORS is present on both the manifest and the segments**: `Access-Control-Allow-Origin: *`, manifest `Content-Type: application/vnd.apple.mpegurl`, segments `video/mp2t`. Rung 2 works as designed, with zero bytes through torlnk.
- **The manifest is a complete VOD playlist** — 1988 segments and a closing `#EXT-X-ENDLIST`, so the full duration is known from the first request and **seeking works immediately**. Better than expected, and a further argument for keeping rung 2 above rung 3, whose event playlist has a growing scrub bar.
- Segments are MPEG-TS, not fMP4. Both hls.js and native Safari HLS handle TS, so this needs no code.

**Two corrections to the plan as written, both from this measurement:**

1. **The quality label is `"full"`, not a resolution.** `apple` was `{ "full": "…/full.m3u8" }`. Task 7's `bestManifest` sorted labels with `Number(b) - Number(a)`, which is `NaN` for `"full"` — the sort is meaningless and only worked by accident with a single key. It must handle named labels as well as numeric ones.
2. **`streamable: 0` still returns 200 with manifest URLs.** For a `.rar` the endpoint happily produced four URLs, and fetching the `.m3u8` then gave `404 {"error":"invalid_duration"}` — with CORS headers, so the browser would see it as a load failure rather than a network error. The endpoint's status therefore cannot be the availability signal. `streamable` must be captured in Task 6 alongside `id` and checked before rung 2 is offered.

- [ ] **Step 5: Record the verdict and commit**

Write one of these three findings into this file, with the captured headers:

- **Both present** → proceed with Tasks 6–9 as written.
- **Either absent** → **stop and report.** Rung 2 then requires proxying the manifest and every segment through torlnk, which is a second proxy route with its own capability auth and its own bandwidth cost. That is a different plan, and the spec says explicitly to reconsider rung 2 against just shipping rung 3 rather than building it on reflex. Tasks 1–5 are unaffected and still worth shipping.
- **`streamable: 0` for most real releases** → report that too; it changes how much rung 2 is worth.

```bash
git add docs/superpowers/plans/2026-07-31-web-player-classification-and-provider-transcode.md
git commit -m "docs: record Real-Debrid transcode endpoint and CORS findings"
```

---

### Task 1: Media facts and playback blockers, from a release name

**Files:**
- Create: `src/util/playability.ts`
- Create: `src/util/playability.test.ts`
- Modify: `src/web/static/playerModel.ts` — remove `extensionOf` (lines 78–85) and re-export it from the new module
- Modify: `src/web/static/playerModel.test.ts` — its `extensionOf` import moves

`extensionOf` moves down to `src/util/` because a second consumer arrives in Task 4 (the server-side `.info` route). That is the codebase's rule, and copying it is what caused four recorded bugs.

**Interfaces:**
- Consumes: `parseRelease` from `src/util/release.ts` — `parseRelease(name: string, hint?: SectionHint): ParsedRelease`, whose relevant fields are `codec?: string` and `audioList?: string[]`, both raw parser vocabulary.
- Produces:
  - `interface MediaFacts { container: string; videoCodec: string; audioCodec: string; source: "probe" | "name" }`
  - `type Blocker = "container" | "video" | "audio"`
  - `function extensionOf(filename: string): string`
  - `function classifyFromName(filename: string, releaseName?: string): MediaFacts`
  - `function blockersFor(facts: MediaFacts): Blocker[]`

- [ ] **Step 1: Write the failing test**

Create `src/util/playability.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { blockersFor, classifyFromName, extensionOf, type MediaFacts } from "./playability";

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  container: "mp4",
  videoCodec: "h264",
  audioCodec: "aac",
  source: "name",
  ...over,
});

describe("extensionOf", () => {
  it("lowercases and drops the dot", () => {
    expect(extensionOf("Kestrel.2010.1080p.BluRay.x264.MKV")).toBe("mkv");
  });

  it("is empty when there is no usable extension", () => {
    expect(extensionOf("Kestrel")).toBe("");
  });
});

describe("classifyFromName", () => {
  it("reads an x264 release as h264", () => {
    expect(classifyFromName("Kestrel.2010.1080p.BluRay.x264.mkv")).toEqual({
      container: "mkv",
      videoCodec: "h264",
      audioCodec: "",
      source: "name",
    });
  });

  it("reads HEVC and Atmos out of a 4K release", () => {
    const f = classifyFromName("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP.mkv");
    expect(f.videoCodec).toBe("hevc");
    expect(f.audioCodec).toBe("truehd");
  });

  it("prefers an explicit release name over the filename", () => {
    // The debrid provider often renames the file; the release name is the
    // richer signal and the caller has both.
    const f = classifyFromName("1.mkv", "Tin.Rivers.2024.2160p.WEB-DL.x265.DTS-GROUP");
    expect(f.videoCodec).toBe("hevc");
    expect(f.audioCodec).toBe("dts");
    expect(f.container).toBe("mkv");
  });

  it("leaves a codec empty rather than guessing when the name says nothing", () => {
    expect(classifyFromName("Ashfall.1999.1080p.mp4").videoCodec).toBe("");
  });
});

describe("blockersFor", () => {
  it("clears a browser-safe mp4", () => {
    expect(blockersFor(facts())).toEqual([]);
  });

  it("blocks matroska on the container", () => {
    expect(blockersFor(facts({ container: "mkv" }))).toEqual(["container"]);
  });

  it("blocks an unknown container, because optimism there costs a black rectangle", () => {
    expect(blockersFor(facts({ container: "" }))).toEqual(["container"]);
  });

  it("blocks hevc in an mp4 — a container browsers take carrying a codec they do not", () => {
    expect(blockersFor(facts({ videoCodec: "hevc" }))).toEqual(["video"]);
  });

  it("blocks dts audio", () => {
    expect(blockersFor(facts({ audioCodec: "dts" }))).toEqual(["audio"]);
  });

  it("reports every blocker, not just the first", () => {
    expect(blockersFor(facts({ container: "mkv", videoCodec: "hevc", audioCodec: "truehd" })))
      .toEqual(["container", "video", "audio"]);
  });

  it("does not block on an unknown codec", () => {
    // A release name that says nothing about audio is the common case. Guessing
    // pessimistically here would send files to the card that play fine today;
    // the runtime error/stall detection is what covers being wrong.
    expect(blockersFor(facts({ videoCodec: "", audioCodec: "" }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/util/playability.test.ts`
Expected: FAIL — `Failed to resolve import "./playability"`.

- [ ] **Step 3: Write the implementation**

Create `src/util/playability.ts`:

```ts
// What a browser can be expected to play, and why it can't when it can't.
//
// Front-end agnostic on purpose: the web's `.info` route builds this server
// side, and the player page's rung selection reads it client side. Both need the
// same vocabulary, so it lives here rather than in either of them.
//
// Nothing here imports node:*. It is reachable from the browser bundle.
import { parseRelease } from "./release";

/** What we know about one file's container and codecs, and how we know it. */
export interface MediaFacts {
  /** Lowercase container: "mkv", "mp4", "webm". Empty when unknown. */
  container: string;
  /** Normalised video codec: "h264", "hevc", "av1", "vp9", "mpeg2". Empty when unknown. */
  videoCodec: string;
  /** Normalised audio codec: "aac", "dts", "truehd", "ac3", "eac3", "flac", "opus". Empty when unknown. */
  audioCodec: string;
  /**
   * `probe` came from ffprobe and is trustworthy. `name` was inferred from a
   * release name and is a good guess — a release named x264 can still carry
   * something else. Consumers must not treat the two as equally reliable when
   * deciding whether to spend money (CPU, bandwidth) on the answer.
   */
  source: "probe" | "name";
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
 */
export function normaliseAudioCodec(list: string[] | undefined): string {
  const all = (list ?? []).map((a) => a.toLowerCase()).join(" ");
  if (!all) return "";
  if (/truehd|atmos/.test(all)) return "truehd";
  if (/dts/.test(all)) return "dts";
  if (/e-?ac-?3|ddp|dd\+/.test(all)) return "eac3";
  if (/ac-?3|dd\b|dolby digital/.test(all)) return "ac3";
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
  const parsed = parseRelease(releaseName || filename);
  return {
    container: extensionOf(filename),
    videoCodec: normaliseVideoCodec(parsed.codec),
    audioCodec: normaliseAudioCodec(parsed.audioList),
    source: "name",
  };
}

/**
 * Every reason a browser will refuse this file.
 *
 * An unknown *container* blocks — that is today's behaviour and it is right,
 * because showing a card is honest and takes one tap to work around where a
 * black rectangle looks like the app is broken. An unknown *codec* does not
 * block: most release names say nothing about audio, and blocking there would
 * send files to the card that play fine.
 */
export function blockersFor(facts: MediaFacts): Blocker[] {
  const blockers: Blocker[] = [];
  if (!SAFE_CONTAINERS.has(facts.container)) blockers.push("container");
  if (facts.videoCodec && !SAFE_VIDEO.has(facts.videoCodec)) blockers.push("video");
  if (facts.audioCodec && !SAFE_AUDIO.has(facts.audioCodec)) blockers.push("audio");
  return blockers;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/util/playability.test.ts`
Expected: PASS.

If `classifyFromName("Tin.Rivers…Atmos…")` does not yield `truehd`, check what `parseRelease` actually put in `audioList` — `console.log` it in the test, adjust the regex in `normaliseAudioCodec` to match the parser's real vocabulary, and keep the test asserting the normalised value.

- [ ] **Step 5: Move `extensionOf` out of `playerModel.ts`**

In `src/web/static/playerModel.ts`, delete the `extensionOf` function and its doc comment (lines 78–85) and replace with a re-export, so existing importers keep working:

```ts
import { extensionOf } from "../../util/playability";

export { extensionOf };
```

`canDirectPlay` still calls `extensionOf` and still works. Leave `canDirectPlay` alone in this task — Task 5 replaces it.

- [ ] **Step 6: Run the full suite and the browser build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass. The build is the check that `src/util/playability.ts` and its `release.ts` import are browser-safe — `release.ts` already ships in the bundle via `nextEpisodeFile.ts`, so this should hold, and a failure here means something in the import graph reached a Node builtin.

- [ ] **Step 7: Commit**

```bash
git add src/util/playability.ts src/util/playability.test.ts src/web/static/playerModel.ts src/web/static/playerModel.test.ts
git commit -m "feat: classify container and codecs from a release name"
```

---

### Task 2: Find ffprobe and ffmpeg on the host, or don't

**Files:**
- Create: `src/util/ffmpegBin.ts`
- Create: `src/util/ffmpegBin.test.ts`

Both binaries are looked up here even though this plan only uses `ffprobe`, because they ship together and the local-HLS plan needs `findFfmpeg` — one module, one pattern, no second lookup to drift from the first.

This deliberately mirrors `PLAYER_CANDIDATES` and `commandExists` in `src/util/player.ts:33-120`: a CLI name looked up with the platform's own lookup tool, plus known Windows install paths with `%ENV%` tokens, and a hard "absent is a normal answer" contract.

**Interfaces:**
- Produces:
  - `type WhichImpl = (cmd: string) => Promise<boolean>` (same shape as `src/util/player.ts`'s)
  - `interface FfmpegBinDeps { whichImpl?: WhichImpl; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }`
  - `function findFfprobe(deps?: FfmpegBinDeps): Promise<string | null>`
  - `function findFfmpeg(deps?: FfmpegBinDeps): Promise<string | null>`
  - `function resetFfmpegBinCache(): void` — tests only; the lookup is memoised per process.

- [ ] **Step 1: Write the failing test**

Create `src/util/ffmpegBin.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { findFfmpeg, findFfprobe, resetFfmpegBinCache } from "./ffmpegBin";

beforeEach(() => resetFfmpegBinCache());

describe("findFfprobe", () => {
  it("returns the PATH name when it resolves", async () => {
    expect(await findFfprobe({ whichImpl: async (c) => c === "ffprobe" })).toBe("ffprobe");
  });

  it("returns null when nothing resolves — an absent binary is a normal answer", async () => {
    expect(await findFfprobe({ whichImpl: async () => false, platform: "linux" })).toBeNull();
  });

  it("falls back to a known Windows install path", async () => {
    const found = await findFfprobe({
      whichImpl: async () => false,
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
    });
    expect(found).toBe("C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe");
  });

  it("skips a Windows path whose env token is undefined", async () => {
    expect(
      await findFfprobe({ whichImpl: async () => false, platform: "win32", env: {} }),
    ).toBeNull();
  });

  it("memoises, so a lookup does not spawn once per request", async () => {
    let calls = 0;
    const whichImpl = async () => {
      calls += 1;
      return true;
    };
    await findFfprobe({ whichImpl });
    await findFfprobe({ whichImpl });
    expect(calls).toBe(1);
  });
});

describe("findFfmpeg", () => {
  it("looks up its own name, not ffprobe's", async () => {
    const asked: string[] = [];
    await findFfmpeg({
      whichImpl: async (c) => {
        asked.push(c);
        return true;
      },
    });
    expect(asked).toEqual(["ffmpeg"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/util/ffmpegBin.test.ts`
Expected: FAIL — `Failed to resolve import "./ffmpegBin"`.

- [ ] **Step 3: Write the implementation**

Create `src/util/ffmpegBin.ts`:

```ts
// Whether this host can transcode, and with which binary.
//
// ffmpeg is NOT a dependency of torlnk. It is detected, and its absence is a
// normal answer that costs the web player a rung on its source ladder and
// nothing else. Nothing here downloads or installs anything.
//
// Deliberately the same shape as PLAYER_CANDIDATES in ./player.ts: a CLI name
// on PATH, plus known Windows install paths, because on Windows a user who
// installed ffmpeg from a zip very often has it nowhere near PATH.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

export type WhichImpl = (cmd: string) => Promise<boolean>;

export interface FfmpegBinDeps {
  whichImpl?: WhichImpl;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

// Absolute-path templates checked on Windows. May contain %ENV% tokens expanded
// against env; a path whose tokens are undefined is skipped rather than probed
// with a literal "%ProgramFiles%" in it.
const WIN_PATHS = [
  "%ProgramFiles%\\ffmpeg\\bin\\{bin}.exe",
  "%ProgramFiles(x86)%\\ffmpeg\\bin\\{bin}.exe",
  "%LocalAppData%\\Microsoft\\WinGet\\Links\\{bin}.exe",
  "%ChocolateyInstall%\\bin\\{bin}.exe",
];

// Whether a command resolves on PATH. Uses the platform's lookup tool; never
// runs the binary itself, because running ffmpeg with no arguments prints a
// banner and exits non-zero, which is not the question being asked.
function commandExists(cmd: string, platform: NodeJS.Platform): Promise<boolean> {
  const [probe, args] = platform === "win32" ? ["where", [cmd]] : ["command", ["-v", cmd]];
  return new Promise((resolve) => {
    try {
      const proc = spawn(probe, args, { windowsHide: true, shell: platform !== "win32" });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve(false);
      }, 3000);
      timer.unref?.();
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

function expandWinPath(template: string, bin: string, env: NodeJS.ProcessEnv): string | null {
  const withBin = template.replace("{bin}", bin);
  let missing = false;
  const expanded = withBin.replace(/%([^%]+)%/g, (_, name: string) => {
    const value = env[name];
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? null : expanded;
}

// Memoised per process: this is asked once per player page load, and spawning a
// lookup each time would be a spawn per request on a path that never changes
// while the process is alive.
const cache = new Map<string, string | null>();

/** Tests only. Clears the memo so each case starts from nothing. */
export function resetFfmpegBinCache(): void {
  cache.clear();
}

async function find(bin: string, deps: FfmpegBinDeps): Promise<string | null> {
  const cached = cache.get(bin);
  if (cached !== undefined) return cached;

  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const which = deps.whichImpl ?? ((c: string) => commandExists(c, platform));

  let found: string | null = null;
  if (await which(bin)) {
    found = bin;
  } else if (platform === "win32") {
    for (const template of WIN_PATHS) {
      const candidate = expandWinPath(template, bin, env);
      if (!candidate) continue;
      try {
        await fs.access(candidate);
        found = candidate;
        break;
      } catch {
        /* not here */
      }
    }
  }
  cache.set(bin, found);
  return found;
}

/** The ffprobe binary to use, or null when this host has none. */
export function findFfprobe(deps: FfmpegBinDeps = {}): Promise<string | null> {
  return find("ffprobe", deps);
}

/** The ffmpeg binary to use, or null when this host has none. */
export function findFfmpeg(deps: FfmpegBinDeps = {}): Promise<string | null> {
  return find("ffmpeg", deps);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/util/ffmpegBin.test.ts`
Expected: PASS. The Windows-path test relies on `fs.access` succeeding for `C:\Program Files\ffmpeg\bin\ffprobe.exe`, which it will not on a Mac — so that test needs the access check stubbed. If it fails, add `accessImpl?: (p: string) => Promise<void>` to `FfmpegBinDeps`, default it to `fs.access`, use it in the loop, and pass `async () => {}` in that one test. Do not weaken the assertion instead.

- [ ] **Step 5: Commit**

```bash
git add src/util/ffmpegBin.ts src/util/ffmpegBin.test.ts
git commit -m "feat: detect ffprobe and ffmpeg without depending on them"
```

---

### Task 3: Probe a URL with ffprobe

**Files:**
- Create: `src/core/probe.ts`
- Create: `src/core/probe.test.ts`

`src/core/` rather than `src/util/`: this spawns a process and talks to the network, so it must never be reachable from the browser bundle, and `src/core` is the front-end-agnostic middle that both front ends may use.

**Interfaces:**
- Consumes: `MediaFacts` from `src/util/playability.ts`; `findFfprobe` from `src/util/ffmpegBin.ts`.
- Produces:
  - `function ffprobeArgs(url: string): string[]`
  - `function parseFfprobe(stdout: string, container: string): MediaFacts | null`
  - `type RunProbe = (bin: string, args: string[]) => Promise<string>`
  - `function probeUrl(url: string, container: string, deps?: { runImpl?: RunProbe; findImpl?: () => Promise<string | null> }): Promise<MediaFacts | null>`

- [ ] **Step 1: Write the failing test**

Create `src/core/probe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ffprobeArgs, parseFfprobe, probeUrl } from "./probe";

const output = (formatName: string, streams: { codec_type: string; codec_name: string }[]) =>
  JSON.stringify({ format: { format_name: formatName }, streams });

describe("ffprobeArgs", () => {
  it("asks for json, quietly, and bounds how much it reads", () => {
    const args = ffprobeArgs("https://cdn.example/Kestrel.mkv");
    expect(args).toContain("-print_format");
    expect(args).toContain("json");
    // A bounded probe matters: this reads over the network from a CDN or a
    // half-downloaded torrent, and an unbounded analyzeduration will sit there.
    expect(args).toContain("-analyzeduration");
    expect(args).toContain("-probesize");
    // The URL is the last argument and is never shell-interpolated.
    expect(args[args.length - 1]).toBe("https://cdn.example/Kestrel.mkv");
  });
});

describe("parseFfprobe", () => {
  it("reads h264 and aac out of an mp4", () => {
    const facts = parseFfprobe(
      output("mov,mp4,m4a,3gp,3g2,mj2", [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "audio", codec_name: "aac" },
      ]),
      "mp4",
    );
    expect(facts).toEqual({ container: "mp4", videoCodec: "h264", audioCodec: "aac", source: "probe" });
  });

  it("reads hevc and dts out of a matroska file", () => {
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "video", codec_name: "hevc" },
        { codec_type: "audio", codec_name: "dts" },
      ]),
      "mkv",
    );
    expect(facts?.videoCodec).toBe("hevc");
    expect(facts?.audioCodec).toBe("dts");
    expect(facts?.container).toBe("mkv");
  });

  it("picks the worst audio track, not the first", () => {
    // A dual-audio release: the browser may select either, so the one it cannot
    // decode is the one that decides the answer.
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "audio", codec_name: "aac" },
        { codec_type: "audio", codec_name: "truehd" },
      ]),
      "mkv",
    );
    expect(facts?.audioCodec).toBe("truehd");
  });

  it("ignores subtitle and attachment streams", () => {
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "subtitle", codec_name: "subrip" },
        { codec_type: "video", codec_name: "h264" },
      ]),
      "mkv",
    );
    expect(facts?.videoCodec).toBe("h264");
    expect(facts?.audioCodec).toBe("");
  });

  it("returns null on output that is not json", () => {
    expect(parseFfprobe("ffprobe: command failed", "mkv")).toBeNull();
  });

  it("returns null when there is no video stream at all", () => {
    // An audio-only or metadata-only response means the probe did not reach the
    // media; classifying from it would be worse than falling back to the name.
    expect(parseFfprobe(output("matroska,webm", []), "mkv")).toBeNull();
  });
});

describe("probeUrl", () => {
  it("returns null when there is no ffprobe, without running anything", async () => {
    let ran = false;
    const facts = await probeUrl("https://cdn.example/a.mkv", "mkv", {
      findImpl: async () => null,
      runImpl: async () => {
        ran = true;
        return "";
      },
    });
    expect(facts).toBeNull();
    expect(ran).toBe(false);
  });

  it("returns null when ffprobe rejects, rather than throwing", async () => {
    const facts = await probeUrl("https://cdn.example/a.mkv", "mkv", {
      findImpl: async () => "ffprobe",
      runImpl: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    expect(facts).toBeNull();
  });

  it("parses a successful run", async () => {
    const facts = await probeUrl("https://cdn.example/a.mkv", "mkv", {
      findImpl: async () => "ffprobe",
      runImpl: async () =>
        output("matroska,webm", [{ codec_type: "video", codec_name: "h264" }]),
    });
    expect(facts?.source).toBe("probe");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/probe.test.ts`
Expected: FAIL — `Failed to resolve import "./probe"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/probe.ts`:

```ts
// Ask ffprobe what a URL actually contains.
//
// This is the accurate half of playback classification; ./util/playability.ts's
// classifyFromName is the always-available half. A probe that fails for any
// reason returns null and the caller falls back to the name — the point of this
// module is a better answer, never a required one.
//
// Spawns a process and reaches the network, so it lives in src/core and must
// never become reachable from src/web/static.
import { spawn } from "node:child_process";
import { findFfprobe } from "../util/ffmpegBin";
import type { MediaFacts } from "../util/playability";

// Bounded on purpose. The URL is a CDN link or a half-downloaded torrent, and
// ffprobe's default analyzeduration will happily sit on a slow first byte. Two
// seconds and 2 MiB is enough to see the stream table of anything real.
const ANALYZE_US = "2000000";
const PROBE_BYTES = "2000000";
const RUN_TIMEOUT_MS = 15_000;

/**
 * The argv for probing one URL.
 *
 * Pure and exported so the interesting part is testable without executing
 * anything. The URL is the final argument and is passed as an argv element —
 * never through a shell, because it is attacker-influenced (it is a debrid
 * link built from a torrent's filename).
 */
export function ffprobeArgs(url: string): string[] {
  return [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_entries",
    "format=format_name:stream=codec_type,codec_name",
    "-analyzeduration",
    ANALYZE_US,
    "-probesize",
    PROBE_BYTES,
    url,
  ];
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
}

// Worst-first, matching normaliseAudioCodec's ordering in ./util/playability.ts
// for the same reason: a dual-audio file offers the browser a choice, and the
// track it cannot decode is the one that decides whether this plays.
const AUDIO_RANK = ["truehd", "dts", "eac3", "ac3", "flac", "opus", "vorbis", "aac", "mp3"];

function worstAudio(names: string[]) {
  for (const rank of AUDIO_RANK) {
    const hit = names.find((n) => n.includes(rank));
    if (hit) return rank;
  }
  return names[0] ?? "";
}

/**
 * Turn ffprobe's json into MediaFacts, or null when it isn't usable.
 *
 * `container` comes from the caller (the filename) rather than from
 * `format_name`, because ffprobe reports a comma-joined family —
 * "mov,mp4,m4a,3gp,3g2,mj2" — that says which demuxer opened it, not which of
 * those the file is. The filename is authoritative about that and nothing else.
 */
export function parseFfprobe(stdout: string, container: string): MediaFacts | null {
  let parsed: { streams?: ProbeStream[] };
  try {
    parsed = JSON.parse(stdout) as { streams?: ProbeStream[] };
  } catch {
    return null;
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video")?.codec_name ?? "";
  // No video stream means the probe never reached the media — a truncated
  // response, an error page, a range the CDN refused. The name is a better
  // answer than this.
  if (!video) return null;
  const audio = streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => (s.codec_name ?? "").toLowerCase())
    .filter(Boolean);
  return {
    container,
    videoCodec: video.toLowerCase() === "avc1" ? "h264" : video.toLowerCase(),
    audioCodec: worstAudio(audio),
    source: "probe",
  };
}

export type RunProbe = (bin: string, args: string[]) => Promise<string>;

// Injected in tests. Runs ffprobe with no shell and a hard timeout, and rejects
// on a non-zero exit so the caller's catch is the single failure path.
const runProbe: RunProbe = (bin, args) =>
  new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject(new Error("ffprobe timed out"));
    }, RUN_TIMEOUT_MS);
    timer.unref?.();
    proc.stdout.on("data", (c: Buffer) => {
      out += c.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ffprobe exited ${code}`));
    });
  });

export interface ProbeDeps {
  runImpl?: RunProbe;
  findImpl?: () => Promise<string | null>;
}

/**
 * Probe one URL, or return null.
 *
 * Every failure — no binary, a timeout, a non-zero exit, unparseable output —
 * is the same null. The caller's job is to fall back to the release name, and
 * distinguishing these would give it nothing to do differently.
 */
export async function probeUrl(
  url: string,
  container: string,
  deps: ProbeDeps = {},
): Promise<MediaFacts | null> {
  const find = deps.findImpl ?? (() => findFfprobe());
  const bin = await find();
  if (!bin) return null;
  const run = deps.runImpl ?? runProbe;
  try {
    return parseFfprobe(await run(bin, ffprobeArgs(url)), container);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/probe.ts src/core/probe.test.ts
git commit -m "feat: probe a stream URL for its real container and codecs"
```

---

### Task 4: Serve the answer at `/stream/:sid/:idx.info?k=…`

**Files:**
- Modify: `src/web/stream.ts` — generalise `splitPlaylistSuffix` (lines 100–106), add the `info` branch to `handleStreamRequest`
- Modify: `src/web/stream.test.ts`
- Modify: `src/web/wire.ts` — add `StreamInfoResponse`
- Modify: `src/web/server.ts` — inject the new dep
- Create: `src/core/probeCache.ts`
- Create: `src/core/probeCache.test.ts`

**Why a representation of the stream handle and not an `/api/` route.** The player page has the session capability (`?k=`) and *not* the server's bearer token — that is the whole reason `?n=` exists in the player URL, per the comment in `playerModel.ts`. Everything under `/api/` is behind the bearer token, so a phone that opened a shared link cannot reach it. The `.m3u` suffix already solves exactly this, and `stream.ts` is explicit that the session lookup, capability check, readiness check and bounds check must be *one* guard chain and not two. So `.info` joins `.m3u` as a second representation behind the same guards.

**Interfaces:**
- Consumes: `probeUrl` (Task 3), `classifyFromName`, `blockersFor`, `extensionOf` (Task 1).
- Produces:
  - `function splitRepresentation(urlPath: string): { path: string; rep: "media" | "playlist" | "info" }` — replaces `splitPlaylistSuffix`
  - In `src/web/wire.ts`: `interface StreamInfoResponse { facts: MediaFacts; blockers: Blocker[]; hls: string | null }`
  - On `StreamDeps`: `probeCache: ProbeCache` and `resolveHls?: (session: StreamSession, index: number) => Promise<string | null>` (left unset in this task; Task 8 wires it)
  - `class ProbeCache { get(sid: string, index: number): MediaFacts | undefined; set(sid: string, index: number, facts: MediaFacts): void }`

- [ ] **Step 1: Write the failing test for the cache**

Create `src/core/probeCache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ProbeCache } from "./probeCache";
import type { MediaFacts } from "../util/playability";

const facts = (videoCodec: string): MediaFacts => ({
  container: "mkv",
  videoCodec,
  audioCodec: "aac",
  source: "probe",
});

describe("ProbeCache", () => {
  it("returns what was stored, keyed by session and index together", () => {
    const cache = new ProbeCache(4);
    cache.set("sid-1", 0, facts("h264"));
    cache.set("sid-1", 1, facts("hevc"));
    expect(cache.get("sid-1", 0)?.videoCodec).toBe("h264");
    expect(cache.get("sid-1", 1)?.videoCodec).toBe("hevc");
    expect(cache.get("sid-2", 0)).toBeUndefined();
  });

  it("does not confuse a session id containing the separator", () => {
    // Session ids are UUIDs today, but a key built by concatenation is a bug
    // waiting for the day they aren't.
    const cache = new ProbeCache(4);
    cache.set("a:1", 0, facts("h264"));
    expect(cache.get("a", 1)).toBeUndefined();
  });

  it("evicts the oldest entry past its bound, so it cannot grow forever", () => {
    const cache = new ProbeCache(2);
    cache.set("s", 0, facts("h264"));
    cache.set("s", 1, facts("hevc"));
    cache.set("s", 2, facts("vp9"));
    expect(cache.get("s", 0)).toBeUndefined();
    expect(cache.get("s", 2)?.videoCodec).toBe("vp9");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/probeCache.test.ts`
Expected: FAIL — `Failed to resolve import "./probeCache"`.

- [ ] **Step 3: Implement the cache**

Create `src/core/probeCache.ts`:

```ts
// Remembers what a probe found, so loading a player page twice does not spawn
// ffprobe twice against a CDN.
//
// Bounded rather than tied to session lifetime on purpose: a bound needs no
// teardown hook, and a stale entry for a dead session is harmless because the
// key includes the session id and ids are never reused.
import type { MediaFacts } from "../util/playability";

const DEFAULT_MAX = 64;

export class ProbeCache {
  private readonly entries = new Map<string, MediaFacts>();

  constructor(private readonly max: number = DEFAULT_MAX) {}

  // JSON-encoded rather than `${sid}:${index}`: a session id containing the
  // separator would otherwise collide with a different (sid, index) pair.
  private key(sid: string, index: number): string {
    return JSON.stringify([sid, index]);
  }

  get(sid: string, index: number): MediaFacts | undefined {
    return this.entries.get(this.key(sid, index));
  }

  set(sid: string, index: number, facts: MediaFacts): void {
    const key = this.key(sid, index);
    this.entries.delete(key);
    this.entries.set(key, facts);
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/core/probeCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

In `src/web/stream.test.ts`, follow the existing harness in that file — it stands up a real `http.Server` because, as its own comment says, a fake HTTP client cannot show that a Range survived a socket. Add:

```ts
describe("the .info representation", () => {
  it("401s without the capability, before it probes anything", async () => {
    const { origin } = await serve();           // existing helper in this file
    const res = await fetch(`${origin}/stream/${sid}/0.info`);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown session", async () => {
    const { origin } = await serve();
    const res = await fetch(`${origin}/stream/nope/0.info?k=${capability}`);
    expect(res.status).toBe(404);
  });

  it("404s for an index past the end of the file list", async () => {
    const { origin } = await serve();
    const res = await fetch(`${origin}/stream/${sid}/99.info?k=${capability}`);
    expect(res.status).toBe(404);
  });

  it("classifies from the name when there is no ffprobe", async () => {
    const { origin } = await serve({
      files: [{ url: "https://cdn.example/x", filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: 1 }],
      probeImpl: async () => null,
    });
    const res = await fetch(`${origin}/stream/${sid}/0.info?k=${capability}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts.source).toBe("name");
    expect(body.facts.videoCodec).toBe("h264");
    expect(body.blockers).toEqual(["container"]);
    expect(body.hls).toBeNull();
  });

  it("prefers the probe when there is one", async () => {
    const { origin } = await serve({
      files: [{ url: "https://cdn.example/x", filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: 1 }],
      probeImpl: async () => ({ container: "mkv", videoCodec: "hevc", audioCodec: "dts", source: "probe" as const }),
    });
    const body = await (await fetch(`${origin}/stream/${sid}/0.info?k=${capability}`)).json();
    expect(body.facts.source).toBe("probe");
    // The name said x264; the file is really hevc. This is the case the probe
    // exists for, and the name-only path would have got it wrong.
    expect(body.blockers).toEqual(["container", "video", "audio"]);
  });

  it("probes once for repeated requests", async () => {
    let probes = 0;
    const { origin } = await serve({
      files: [{ url: "https://cdn.example/x", filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: 1 }],
      probeImpl: async () => {
        probes += 1;
        return { container: "mkv", videoCodec: "h264", audioCodec: "aac", source: "probe" as const };
      },
    });
    await fetch(`${origin}/stream/${sid}/0.info?k=${capability}`);
    await fetch(`${origin}/stream/${sid}/0.info?k=${capability}`);
    expect(probes).toBe(1);
  });

  it("does not probe a file the name already says is playable", async () => {
    // The common path. A probe is a spawn plus a network round trip bounded at
    // 15s; paying it for an mp4 that was going to play anyway would make every
    // player page load slower to catch a rare mislabelled file.
    let probes = 0;
    const { origin } = await serve({
      files: [{ url: "https://cdn.example/x", filename: "Ashfall.1999.1080p.mp4", bytes: 1 }],
      probeImpl: async () => {
        probes += 1;
        return null;
      },
    });
    const body = await (await fetch(`${origin}/stream/${sid}/0.info?k=${capability}`)).json();
    expect(probes).toBe(0);
    expect(body.blockers).toEqual([]);
    expect(body.facts.source).toBe("name");
  });

  it("never puts the upstream url in the response", async () => {
    // The debrid link is a credential against the user's account. The page has
    // no business seeing it and must keep using /stream/:sid/:idx.
    const { origin } = await serve({
      files: [{ url: "https://cdn.example/secret-token/x.mkv", filename: "Kestrel.2010.1080p.x264.mkv", bytes: 1 }],
    });
    const text = await (await fetch(`${origin}/stream/${sid}/0.info?k=${capability}`)).text();
    expect(text).not.toContain("secret-token");
  });

  it("still serves media at the unsuffixed path", async () => {
    // The suffix generalisation must not have broken the route it grew out of.
    const { origin } = await serve();
    const res = await fetch(`${origin}/stream/${sid}/0?k=${capability}`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  it("still serves the playlist at .m3u", async () => {
    const { origin } = await serve();
    const res = await fetch(`${origin}/stream/${sid}/0.m3u?k=${capability}`);
    expect(res.headers.get("content-type")).toContain("audio/x-mpegurl");
  });
});
```

Extend the file's existing `serve()` helper to accept `probeImpl` and pass it into `StreamDeps`. Keep its existing defaults so every other test in the file is untouched.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/web/stream.test.ts`
Expected: FAIL — the `.info` requests 404, because `splitRepresentation` does not exist and the suffix is not recognised.

- [ ] **Step 7: Generalise the suffix parser**

In `src/web/stream.ts`, replace `splitPlaylistSuffix` with:

```ts
const PLAYLIST_SUFFIX = ".m3u";
const INFO_SUFFIX = ".info";

/** Which representation of the stream handle a path is asking for. */
export type StreamRep = "media" | "playlist" | "info";

/**
 * `/stream/:sid/:idx[.m3u|.info]` → the handle path and the representation.
 *
 * All three go through ONE guard chain in handleStreamRequest — the session
 * lookup, the capability check, the readiness check and the bounds check are
 * literally the same code for each. A `.m3u` that skipped the capability would
 * hand out a playable URL to anyone who guessed a session id, and a `.info`
 * that skipped it would hand out a filename and codec list; the only durable
 * way to stop both is for there to be one guard, not three.
 */
export function splitRepresentation(urlPath: string): { path: string; rep: StreamRep } {
  if (urlPath.endsWith(PLAYLIST_SUFFIX)) {
    return { path: urlPath.slice(0, -PLAYLIST_SUFFIX.length), rep: "playlist" };
  }
  if (urlPath.endsWith(INFO_SUFFIX)) {
    return { path: urlPath.slice(0, -INFO_SUFFIX.length), rep: "info" };
  }
  return { path: urlPath, rep: "media" };
}
```

Update the call site in `handleStreamRequest` (currently `const { path: handlePath, playlist } = splitPlaylistSuffix(urlPath);`) to `const { path: handlePath, rep } = splitRepresentation(urlPath);`, and change the existing `if (playlist)` branch to `if (rep === "playlist")`. Grep for `splitPlaylistSuffix` across the repo and update every reference, tests included.

- [ ] **Step 8: Add the info branch**

Add to `StreamDeps` in `src/web/stream.ts`:

```ts
  /** Remembers probe results so a page reload does not re-probe. */
  probeCache: ProbeCache;
  /**
   * Probe one upstream URL. Injected so the suite never spawns ffprobe, and so
   * a host without it is the default rather than a special case.
   */
  probeImpl?: (url: string, container: string) => Promise<MediaFacts | null>;
  /**
   * The provider's own HLS manifest for this file, or null. Unset until the
   * provider-transcode task wires it, and null-returning is a normal answer.
   */
  resolveHls?: (session: StreamSession, index: number) => Promise<string | null>;
```

In `handleStreamRequest`, immediately after the existing bounds check that yields the `file`, and before the playlist branch:

```ts
  if (rep === "info") {
    const container = extensionOf(file.filename);
    let facts = deps.probeCache.get(parsed.sid, parsed.index);
    if (!facts) {
      // Only probe a file we would otherwise refuse.
      //
      // A probe is a spawn plus a network round trip against a CDN or a
      // half-downloaded torrent, and it is bounded at 15s. Paying that on every
      // player page load — including the mp4 that was going to play instantly —
      // to catch the uncommon mp4-carrying-HEVC would make the common path
      // markedly slower to serve the rare one. So the name decides first, and
      // the probe only runs when the name says this needs a rung above direct
      // play, where the accurate answer is what picks the rung.
      //
      // The cost of this order: an mp4 whose HEVC the name does not mention
      // still gets optimism, a decode error and the card — the same as before
      // this route existed, and one tap from working. That is the trade.
      const fromName = classifyFromName(file.filename, session.name);
      if (blockersFor(fromName).length === 0) {
        facts = fromName;
      } else {
        const probe = deps.probeImpl ?? ((url: string, c: string) => probeUrl(url, c));
        // A probe failure is not an error: classifyFromName is always available,
        // and `session.name` is the release the file came from, which is a
        // better codec signal than a debrid-renamed filename.
        facts = (await probe(file.url, container)) ?? fromName;
      }
      deps.probeCache.set(parsed.sid, parsed.index, facts);
    }
    const hls = deps.resolveHls ? await deps.resolveHls(session, parsed.index) : null;
    const body: StreamInfoResponse = { facts, blockers: blockersFor(facts), hls };
    writeJson(res, 200, body);
    return 200;
  }
```

Add the type to `src/web/wire.ts`:

```ts
/**
 * `GET /stream/:sid/:idx.info?k=…` — what this file is, and how to play it.
 *
 * Capability-authenticated rather than bearer-authenticated, because the player
 * page is reachable by a phone that has the link and not the token.
 *
 * Deliberately does NOT carry the upstream URL. That is a debrid unrestricted
 * link, i.e. a credential against the user's account; the page plays through
 * `/stream/:sid/:idx` and never learns where the bytes come from.
 */
export interface StreamInfoResponse {
  facts: MediaFacts;
  blockers: Blocker[];
  /** A provider HLS manifest the browser can play directly, or null. */
  hls: string | null;
}
```

In `src/web/server.ts`, construct one `ProbeCache` for the process and pass it in `StreamDeps` where the stream handler is mounted.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/web/stream.test.ts src/web/server.test.ts`
Expected: PASS.

- [ ] **Step 10: Full checks and commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

```bash
git add src/core/probeCache.ts src/core/probeCache.test.ts src/web/stream.ts src/web/stream.test.ts src/web/wire.ts src/web/server.ts
git commit -m "feat: serve container and codec facts at /stream/:sid/:idx.info"
```

---

### Task 5: Pick a rung on the player page

**Files:**
- Modify: `src/web/static/playerModel.ts` — add `chooseSource`, retire `canDirectPlay`, extend `fallbackMessage`
- Modify: `src/web/static/playerModel.test.ts`
- Modify: `src/web/static/player.ts` — fetch `.info`, then decide

This is the task that removes the twelve-second black rectangle: an mp4 carrying HEVC is now known to be unplayable before a `<video>` is created.

**Interfaces:**
- Consumes: `StreamInfoResponse`, `MediaFacts`, `Blocker`.
- Produces:
  - `type Rung = "direct" | "provider-hls" | "card"` — the local-HLS plan adds `"local-hls"`
  - `function chooseSource(info: StreamInfoResponse | null, filename: string): { rung: Rung; reason: FallbackReason | null }`
  - `FallbackReason` gains `"video-codec"` and `"audio-codec"`
  - `function infoPath(target: PlayerTarget): string`

- [ ] **Step 1: Write the failing test**

Add to `src/web/static/playerModel.test.ts`:

```ts
import { chooseSource, infoPath } from "./playerModel";
import type { StreamInfoResponse } from "../wire";

const info = (over: Partial<StreamInfoResponse> = {}): StreamInfoResponse => ({
  facts: { container: "mp4", videoCodec: "h264", audioCodec: "aac", source: "probe" },
  blockers: [],
  hls: null,
  ...over,
});

describe("infoPath", () => {
  it("is the stream handle plus .info, carrying the capability", () => {
    expect(infoPath(target())).toBe("/stream/sid-1/0.info?k=cap-1");
  });
});

describe("chooseSource", () => {
  it("plays a clean file directly", () => {
    expect(chooseSource(info(), "Ashfall.1999.1080p.mp4")).toEqual({ rung: "direct", reason: null });
  });

  it("prefers the provider's HLS over the card when the container is wrong", () => {
    const chosen = chooseSource(info({ blockers: ["container"], hls: "https://rd.example/x.m3u8" }), "Kestrel.2010.1080p.BluRay.x264.mkv");
    expect(chosen.rung).toBe("provider-hls");
  });

  it("ignores an offered HLS when the file already plays directly", () => {
    // The provider's transcode is a re-encode. Taking it for a file the browser
    // can play losslessly would be a pointless quality loss.
    const chosen = chooseSource(info({ hls: "https://rd.example/x.m3u8" }), "Ashfall.1999.1080p.mp4");
    expect(chosen.rung).toBe("direct");
  });

  it("falls to the card with the video reason when nothing else is available", () => {
    expect(chooseSource(info({ facts: { container: "mp4", videoCodec: "hevc", audioCodec: "aac", source: "probe" }, blockers: ["video"] }), "Tin.Rivers.2024.2160p.mp4")).toEqual({
      rung: "card",
      reason: "video-codec",
    });
  });

  it("names audio as the reason when audio is the only blocker", () => {
    expect(chooseSource(info({ blockers: ["audio"] }), "Kestrel.2010.1080p.mp4").reason).toBe("audio-codec");
  });

  it("names the container when it is among the blockers, because it is the one a user recognises", () => {
    expect(chooseSource(info({ blockers: ["container", "video", "audio"] }), "Tin.Rivers.2024.2160p.mkv").reason).toBe("container");
  });

  it("falls back to the filename when .info could not be fetched", () => {
    // A phone that lost the network mid-load, or an older server. The page must
    // still do something sensible rather than showing nothing.
    expect(chooseSource(null, "Ashfall.1999.1080p.mp4")).toEqual({ rung: "direct", reason: null });
    expect(chooseSource(null, "Kestrel.2010.1080p.BluRay.x264.mkv")).toEqual({
      rung: "card",
      reason: "container",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/static/playerModel.test.ts`
Expected: FAIL — `chooseSource` and `infoPath` are not exported.

- [ ] **Step 3: Implement**

In `src/web/static/playerModel.ts`, extend the import added in Task 1 — `chooseSource` needs the classifier too, for the case where `.info` could not be fetched:

```ts
import { blockersFor, classifyFromName, extensionOf, type Blocker } from "../../util/playability";
import type { StreamInfoResponse } from "../wire";

export { extensionOf };
```

then add:

```ts
/** The `.info` path for a target. Same address, facts representation. */
export function infoPath(target: PlayerTarget): string {
  const base = `/stream/${encodeURIComponent(target.sid)}/${target.index}.info`;
  return target.capability ? `${base}?k=${encodeURIComponent(target.capability)}` : base;
}

/**
 * Which rung of the source ladder to play this on.
 *
 * The order is the design's: direct play first because it is lossless and free,
 * then the provider's transcode, then the card. The provider's HLS is a
 * re-encode, so it is used only when direct play is actually blocked.
 *
 * `info === null` means the `.info` fetch failed — an offline phone, or a page
 * served by an older build. Falling back to the filename keeps the page working
 * and is exactly what it did before this route existed.
 */
export function chooseSource(
  info: StreamInfoResponse | null,
  filename: string,
): { rung: Rung; reason: FallbackReason | null } {
  const blockers = info ? info.blockers : blockersFor(classifyFromName(filename));
  if (blockers.length === 0) return { rung: "direct", reason: null };
  if (info?.hls) return { rung: "provider-hls", reason: null };
  return { rung: "card", reason: reasonFor(blockers) };
}

// The container is named first when present because it is the blocker a user
// can recognise and act on ("it's an mkv"); a codec name is not.
function reasonFor(blockers: Blocker[]): FallbackReason {
  if (blockers.includes("container")) return "container";
  if (blockers.includes("video")) return "video-codec";
  return "audio-codec";
}
```

Add `"video-codec"` and `"audio-codec"` to `FallbackReason`, and to `fallbackMessage`:

```ts
  if (reason === "video-codec") {
    return `${name} is in a container browsers accept but uses video (HEVC or AV1) they can't decode. Open it in a real player — the stream itself is fine.`;
  }
  if (reason === "audio-codec") {
    return `${name} has audio browsers can't decode (usually DTS or TrueHD). Open it in a real player — the stream itself is fine.`;
  }
```

Delete `canDirectPlay` and `DIRECT_PLAY_CONTAINERS`; `chooseSource` replaces both. Grep for `canDirectPlay` and update every reference — there is one in `player.ts:172`, one in `playerModel.ts`'s own doc comment for `PlayerTarget.filename`, and a mention in `streamFlow.ts:96`. Fix the comments too; a comment describing a function that no longer exists is how the next reader gets misled.

- [ ] **Step 4: Rewire `player.ts`**

Replace `render()`'s tail. The function becomes async, and the `.info` fetch happens before any decision. No conditional deciding *what to show* may be written here — `chooseSource` owns that.

```ts
async function fetchInfo(target: PlayerTarget): Promise<StreamInfoResponse | null> {
  try {
    const res = await fetch(absoluteUrl(location.origin, infoPath(target)));
    if (!res.ok) return null;
    return (await res.json()) as StreamInfoResponse;
  } catch {
    // Offline, or an older server that has no .info. chooseSource handles null.
    return null;
  }
}
```

and, where `if (!canDirectPlay(...))` was:

```ts
  const info = await fetchInfo(target);
  const chosen = chooseSource(info, target.filename);
  if (chosen.rung === "card") {
    showFallback(chosen.reason ?? "container", target.filename);
    return;
  }
  if (chosen.rung === "provider-hls" && info?.hls) {
    await mountHls(video(target), info.hls, target);   // Task 9 adds mountHls
    return;
  }
  mountVideo(target, stream);
```

In this task `mountHls` does not exist yet, so leave the `provider-hls` branch calling `showFallback("container", target.filename)` with a `// Task 9 replaces this with mountHls` comment, and let Task 9 replace it. Do not leave the branch unhandled — an unreachable-looking branch that silently renders nothing is the failure mode this codebase keeps writing comments about.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/web/static/playerModel.test.ts && npm run build`
Expected: PASS, and the build succeeds — `playerModel.ts` now imports from `src/util/playability.ts`, and the build is what proves that import is browser-safe.

- [ ] **Step 6: Run it for real**

Run: `npm run dev -- serve --web`, start a stream of an mp4 and of an mkv, and open the player for each. Expected: the mp4 plays; the mkv shows the card **immediately**, not after twelve seconds.

- [ ] **Step 7: Commit**

```bash
git add src/web/static/playerModel.ts src/web/static/playerModel.test.ts src/web/static/player.ts src/web/static/streamFlow.ts
git commit -m "feat: pick a playback rung from real codec facts, not the extension"
```

---

### Task 6: Keep the provider's file id

**Files:**
- Modify: `src/util/player.ts:14` — `StreamFile` gains `providerFileId?: string`
- Modify: `src/integrations/debrid/realdebrid.ts:299-307` — `unrestrictLink` keeps `id`
- Modify: `src/integrations/debrid/realdebrid.test.ts`
- Check: `src/web/wire.ts` — `PublicStreamFile` must **not** grow this field

`unrestrictLink` currently reads `download`, `filename` and `filesize` out of RD's response and drops `id` — which is the `{id}` the transcode endpoint takes. `ResolvedFile` is a type alias for `StreamFile` (`realdebrid.ts:26`), so this is one field in one place.

**Interfaces:**
- Produces: `StreamFile.providerFileId?: string` — the provider's own id for this file, present only for a debrid-resolved file.

- [ ] **Step 1: Write the failing test**

In `src/integrations/debrid/realdebrid.test.ts`, find the existing `unrestrictLink` test and add:

```ts
it("keeps the provider's file id, which the transcode endpoint needs", async () => {
  const fetchImpl = jsonOnce({
    id: "ABCD1234",
    download: "https://cdn.example/Kestrel.2010.1080p.BluRay.x264.mkv",
    filename: "Kestrel.2010.1080p.BluRay.x264.mkv",
    filesize: 4096,
  });
  const file = await unrestrictLink("tok", "https://host.example/x", { fetchImpl });
  expect(file.providerFileId).toBe("ABCD1234");
});

it("leaves the id undefined when the response has none", async () => {
  const fetchImpl = jsonOnce({ download: "https://cdn.example/x", filename: "x.mkv", filesize: 1 });
  const file = await unrestrictLink("tok", "https://host.example/x", { fetchImpl });
  expect(file.providerFileId).toBeUndefined();
});
```

Use whatever fetch-stub helper that file already has rather than inventing `jsonOnce` — match the surrounding tests.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/integrations/debrid/realdebrid.test.ts`
Expected: FAIL — `providerFileId` is undefined in the first case.

- [ ] **Step 3: Implement**

In `src/util/player.ts`:

```ts
export interface StreamFile {
  url: string;
  filename: string;
  bytes: number;
  /**
   * The provider's own id for this file, when a debrid service resolved it.
   * Server-side only: it is the handle their transcode endpoint takes, and it
   * is deliberately absent from `PublicStreamFile` because the browser has no
   * use for it. Undefined for a WebTorrent file, which has no such thing.
   */
  providerFileId?: string;
}
```

In `src/integrations/debrid/realdebrid.ts`:

```ts
  const parsed = (await res.json()) as {
    id?: string;
    download: string;
    filename: string;
    filesize?: number;
  };
  return {
    url: parsed.download,
    filename: parsed.filename,
    bytes: parsed.filesize ?? 0,
    providerFileId: parsed.id,
  };
```

- [ ] **Step 4: Confirm it did not leak to the browser**

Run: `grep -n "providerFileId" src/web/wire.ts src/web/routes.ts`
Expected: no matches. If `PublicStreamFile` is built by spreading a `StreamFile`, fix it to name its fields explicitly — a wire type built by spread will silently publish every field added to the source type from now on.

- [ ] **Step 5: Run the tests and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/util/player.ts src/integrations/debrid/realdebrid.ts src/integrations/debrid/realdebrid.test.ts
git commit -m "feat: keep the debrid provider's file id on a resolved file"
```

---

### Task 7: Ask the provider for a transcode manifest

**Files:**
- Modify: `src/integrations/debrid/types.ts` — optional `transcodeManifest` on `DebridProvider`
- Modify: `src/integrations/debrid/realdebrid.ts` — implement it
- Modify: `src/integrations/debrid/realdebrid.test.ts`
- Modify: `src/integrations/debrid/torbox.ts` — see step 5

**Gated on Task 0.** Use the response shape recorded there, not the shape guessed below; if they differ, the recorded one wins and the test changes with it.

**Optional because its absence is the capability flag** — the existing pattern for `checkCached?`, which Real-Debrid does not have because RD removed instant availability in 2024.

**Interfaces:**
- Produces: `DebridProvider.transcodeManifest?(token: string, fileId: string, opts?: RequestOptions): Promise<string | null>` — one HLS manifest URL, the highest quality offered, or `null` when the provider will not transcode this file.

- [ ] **Step 1: Write the failing test**

In `src/integrations/debrid/realdebrid.test.ts`:

```ts
describe("transcodeManifest", () => {
  it("returns the highest-quality apple manifest", async () => {
    const fetchImpl = jsonOnce({
      apple: { "1080": "https://sg.real-debrid.com/x/1080.m3u8", "480": "https://sg.real-debrid.com/x/480.m3u8" },
      dash: { "1080": "https://sg.real-debrid.com/x/1080.mpd" },
    });
    expect(await transcodeManifest("tok", "ABCD1234", { fetchImpl })).toBe(
      "https://sg.real-debrid.com/x/1080.m3u8",
    );
  });

  it("returns null when the provider offers no HLS for this file", async () => {
    const fetchImpl = jsonOnce({ dash: { "1080": "https://sg.real-debrid.com/x/1080.mpd" } });
    expect(await transcodeManifest("tok", "ABCD1234", { fetchImpl })).toBeNull();
  });

  it("returns null rather than throwing when the endpoint errors", async () => {
    // A file RD will not transcode is a normal outcome, not a failure the
    // caller should have to catch — it means "use the next rung".
    const fetchImpl = statusOnce(404);
    expect(await transcodeManifest("tok", "ABCD1234", { fetchImpl })).toBeNull();
  });

  it("returns null on a response that is not the documented shape", async () => {
    const fetchImpl = jsonOnce({ error: "unavailable" });
    expect(await transcodeManifest("tok", "ABCD1234", { fetchImpl })).toBeNull();
  });

  it("does not retry — a transcode request is not worth a retry budget", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("", { status: 503 });
    };
    await transcodeManifest("tok", "ABCD1234", { fetchImpl });
    expect(calls).toBe(1);
  });
});
```

Match the file's existing stub helpers rather than inventing `jsonOnce`/`statusOnce`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/integrations/debrid/realdebrid.test.ts`
Expected: FAIL — `transcodeManifest` is not exported.

- [ ] **Step 3: Implement it on Real-Debrid**

In `src/integrations/debrid/realdebrid.ts`:

```ts
// Quality labels are numeric strings ("1080", "720", "480") in RD's response.
// Highest first: this is the browser's only playable option for the file, so
// there is no reason to hand it a smaller one, and RD serves what it has.
function bestManifest(byQuality: Record<string, unknown>): string | null {
  const labels = Object.keys(byQuality).sort((a, b) => Number(b) - Number(a));
  for (const label of labels) {
    const url = byQuality[label];
    if (typeof url === "string" && url.startsWith("http")) return url;
  }
  return null;
}

/**
 * The provider's own HLS manifest for an unrestricted file, or null.
 *
 * `fileId` is the `id` from `/unrestrict/link`, kept on `StreamFile` as
 * `providerFileId`. Null is a normal answer with several causes — RD will not
 * transcode this file, the endpoint is unavailable, the account cannot — and
 * none of them are worth distinguishing: the caller's next move is the same.
 *
 * `retries: 0`. This is not idempotent work worth repeating, and the caller is
 * a page load waiting on it; a retry budget here buys a slower fallback.
 */
export async function transcodeManifest(
  token: string,
  fileId: string,
  opts: RequestOptions = {},
): Promise<string | null> {
  try {
    const res = await request(
      token,
      "GET",
      `/streaming/transcode/${encodeURIComponent(fileId)}`,
      undefined,
      { ...opts, retries: 0 },
    );
    const parsed = (await res.json()) as Record<string, unknown>;
    const apple = parsed.apple;
    if (!apple || typeof apple !== "object") return null;
    return bestManifest(apple as Record<string, unknown>);
  } catch {
    return null;
  }
}
```

Add it to the provider object exported from this file, and to `DebridProvider` in `types.ts`:

```ts
  /**
   * The provider's own HLS manifest for one already-resolved file, so the
   * browser can play a container it could not otherwise touch without this
   * machine transcoding anything. Present ONLY where the provider supports it —
   * its absence is the capability flag, exactly as for `checkCached` above.
   */
  transcodeManifest?(token: string, fileId: string, opts?: RequestOptions): Promise<string | null>;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/integrations/debrid/realdebrid.test.ts`
Expected: PASS.

- [ ] **Step 5: Settle TorBox, in writing**

Read TorBox's current API documentation and establish whether it exposes a transcode or HLS manifest endpoint for a file (`requestdl` is a direct link, not a manifest, so it is not one).

- If it does: implement `transcodeManifest` on the TorBox provider the same way, with its own tests, in this task.
- If it does not: **leave the method off the TorBox provider** and add a comment in `torbox.ts` next to the provider object saying so, dated, with the doc URL checked. An absent method is the capability flag and needs no other code. Record the finding in this plan file under this step.

Either way, add a test asserting the ladder behaves for a provider without the method:

```ts
it("has no transcodeManifest, so the ladder falls through to the next rung", () => {
  expect(torbox.transcodeManifest).toBeUndefined();
});
```

(Delete that test if you implemented the method instead.)

- [ ] **Step 6: Commit**

```bash
git add src/integrations/debrid/types.ts src/integrations/debrid/realdebrid.ts src/integrations/debrid/realdebrid.test.ts src/integrations/debrid/torbox.ts src/integrations/debrid/torbox.test.ts docs/superpowers/plans/2026-07-31-web-player-classification-and-provider-transcode.md
git commit -m "feat: ask a debrid provider for an HLS transcode manifest"
```

---

### Task 8: Wire the manifest into `.info`

**Files:**
- Modify: `src/web/server.ts` — supply `resolveHls` in `StreamDeps`
- Create: `src/web/hlsSource.ts`
- Create: `src/web/hlsSource.test.ts`
- Modify: `src/web/stream.test.ts`

The resolver lives in its own module rather than inline in `server.ts` because it makes three decisions worth testing — is this a debrid session, does this provider do transcoding, does this file have an id — and `server.ts` is wiring.

**Note on the spec:** the spec proposed a `debridTranscode` capability flag on `/api/sources`. It is deliberately **not** built: rung 2 is resolved entirely server-side in `.info`, so nothing in the browser consumes such a flag, and an unused wire field is a thing to keep in sync for nothing. If a future dashboard affordance needs it, add it then.

**Interfaces:**
- Consumes: `StreamSession`, `resolveActiveDebrid` (the same one `src/web/routes.ts` uses for `/api/sources`), `getDebridProvider`, `loadConfig`.
- Produces: `function makeResolveHls(deps: { loadConfigImpl?: () => Promise<Config> }): (session: StreamSession, index: number) => Promise<string | null>`

- [ ] **Step 1: Write the failing test**

Create `src/web/hlsSource.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeResolveHls } from "./hlsSource";
import type { StreamSession } from "../core/streamSession";

const session = (over: Partial<StreamSession> = {}): StreamSession =>
  ({
    id: "sid-1",
    capability: "cap-1",
    backendHandle: null,
    backend: "debrid",
    provider: "realdebrid",
    name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
    state: "ready",
    files: [{ url: "https://cdn.example/x", filename: "Kestrel.mkv", bytes: 1, providerFileId: "ABCD" }],
    progress: 100,
    createdAt: 0,
    ...over,
  }) as StreamSession;

describe("makeResolveHls", () => {
  it("returns null for a torrent-backed session — there is no provider to ask", async () => {
    const resolve = makeResolveHls({ providerImpl: () => ({ transcodeManifest: async () => "https://x/y.m3u8" }) as never });
    expect(await resolve(session({ backend: "torrent", provider: undefined }), 0)).toBeNull();
  });

  it("returns null when the file has no provider id", async () => {
    const resolve = makeResolveHls({ providerImpl: () => ({ transcodeManifest: async () => "https://x/y.m3u8" }) as never });
    const s = session({ files: [{ url: "https://cdn.example/x", filename: "Kestrel.mkv", bytes: 1 }] });
    expect(await resolve(s, 0)).toBeNull();
  });

  it("returns null when the provider does not do transcoding", async () => {
    const resolve = makeResolveHls({ providerImpl: () => ({}) as never });
    expect(await resolve(session(), 0)).toBeNull();
  });

  it("returns null when there is no configured token", async () => {
    const resolve = makeResolveHls({
      tokenImpl: async () => null,
      providerImpl: () => ({ transcodeManifest: async () => "https://x/y.m3u8" }) as never,
    });
    expect(await resolve(session(), 0)).toBeNull();
  });

  it("returns the manifest when everything is in place", async () => {
    const resolve = makeResolveHls({
      tokenImpl: async () => "tok",
      providerImpl: () => ({ transcodeManifest: async () => "https://x/y.m3u8" }) as never,
    });
    expect(await resolve(session(), 0)).toBe("https://x/y.m3u8");
  });

  it("returns null rather than throwing when the provider call fails", async () => {
    const resolve = makeResolveHls({
      tokenImpl: async () => "tok",
      providerImpl: () =>
        ({
          transcodeManifest: async () => {
            throw new Error("network");
          },
        }) as never,
    });
    expect(await resolve(session(), 0)).toBeNull();
  });

  it("returns null for an index that is not in the file list", async () => {
    const resolve = makeResolveHls({
      tokenImpl: async () => "tok",
      providerImpl: () => ({ transcodeManifest: async () => "https://x/y.m3u8" }) as never,
    });
    expect(await resolve(session(), 99)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/hlsSource.test.ts`
Expected: FAIL — `Failed to resolve import "./hlsSource"`.

- [ ] **Step 3: Implement**

Create `src/web/hlsSource.ts`:

```ts
// Whether the debrid provider will hand the browser an HLS manifest for a file,
// which is rung 2 of the player's source ladder: a container the browser cannot
// demux, played without this machine transcoding a byte.
//
// Every "no" is the same null, because the caller's next move is identical for
// all of them — fall to the next rung.
import { getDebridProvider } from "../integrations/debrid";
import type { DebridProvider } from "../integrations/debrid/types";
import type { StreamSession } from "../core/streamSession";

export interface ResolveHlsDeps {
  /** The active provider's token, or null when none is configured. */
  tokenImpl?: () => Promise<string | null>;
  /** Injected in tests; `getDebridProvider` in production. */
  providerImpl?: (session: StreamSession) => DebridProvider;
}

export function makeResolveHls(
  deps: ResolveHlsDeps = {},
): (session: StreamSession, index: number) => Promise<string | null> {
  return async (session, index) => {
    // Only a debrid-backed session has a provider to ask. A WebTorrent session
    // is rung 3's problem.
    if (session.backend !== "debrid" || !session.provider) return null;
    const file = session.files[index];
    if (!file?.providerFileId) return null;

    const provider = deps.providerImpl
      ? deps.providerImpl(session)
      : getDebridProvider(session.provider);
    // Absence of the method IS the capability flag. Same pattern as checkCached.
    if (!provider.transcodeManifest) return null;

    const token = deps.tokenImpl ? await deps.tokenImpl() : null;
    if (!token) return null;

    try {
      return await provider.transcodeManifest(token, file.providerFileId);
    } catch {
      return null;
    }
  };
}
```

- [ ] **Step 4: Do NOT wire it into `server.ts` yet**

`resolveHls` stays unset in `StreamDeps` until Task 9. This is not tidiness — it is a correctness ordering. `chooseSource` returns `provider-hls` whenever `info.hls` is non-null, and until Task 9 exists the player page's `provider-hls` branch is the placeholder from Task 5 Step 4, which shows the fallback card. So wiring the resolver now would make a debrid MKV with a perfectly good manifest display a card *claiming the container is unplayable* while the manifest sits unused — a wrong message, not a stub.

Write the wiring code as a comment in `server.ts` next to the `StreamDeps` construction, so Task 9 has one place to uncomment:

```ts
  // Task 9 enables rung 2 here, once the player page can mount an HLS manifest:
  //   resolveHls: makeResolveHls({ tokenImpl }),
  // tokenImpl does loadConfig() -> resolveActiveDebrid(config) -> that
  // provider's token, resolved THE SAME WAY /api/sources does it so env-var
  // overrides count, and reading config per call rather than holding a snapshot
  // (CLAUDE.md: a held snapshot silently serves a stale token).
```

- [ ] **Step 5: Add the end-to-end route test**

In `src/web/stream.test.ts`:

```ts
it("reports the provider's manifest in .info when one is offered", async () => {
  const { origin } = await serve({
    files: [{ url: "https://cdn.example/x", filename: "Kestrel.2010.1080p.BluRay.x264.mkv", bytes: 1 }],
    probeImpl: async () => null,
    resolveHls: async () => "https://sg.real-debrid.com/x/1080.m3u8",
  });
  const body = await (await fetch(`${origin}/stream/${sid}/0.info?k=${capability}`)).json();
  expect(body.hls).toBe("https://sg.real-debrid.com/x/1080.m3u8");
  expect(body.blockers).toContain("container");
});
```

Extend the `serve()` helper to accept `resolveHls` alongside `probeImpl`.

- [ ] **Step 6: Run the tests, then commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

```bash
git add src/web/hlsSource.ts src/web/hlsSource.test.ts src/web/server.ts src/web/stream.test.ts
git commit -m "feat: offer the provider's HLS manifest from the .info route"
```

---

### Task 9: Play HLS in the browser

**Files:**
- Modify: `package.json` — add `hls.js`
- Modify: `tsup.web.config.ts` — add `hls.js` to `noExternal`
- Create: `src/web/static/hlsMount.ts`
- Create: `src/web/static/hlsMount.test.ts`
- Modify: `src/web/static/player.ts` — replace the Task 5 placeholder branch

**iOS forces the native path, and it is not a preference.** iPhone Safari has no Media Source Extensions, so hls.js cannot run there at all — but Safari plays HLS natively from `video.src`. Given the audience is largely a phone on the sofa, the native path is the more important of the two.

**Interfaces:**
- Produces:
  - `type HlsStrategy = "native" | "mse" | "unsupported"`
  - `function hlsStrategy(canPlayHls: (type: string) => string, hasMse: boolean): HlsStrategy`
  - `async function mountHls(video: HTMLVideoElement, manifest: string, hooks: { onError: () => void }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/web/static/hlsMount.test.ts`. Only `hlsStrategy` is testable — `mountHls` touches the DOM and loads a library, so it is wiring, and this is exactly the split `CLAUDE.md` requires.

```ts
import { describe, expect, it } from "vitest";
import { hlsStrategy } from "./hlsMount";

const yes = () => "maybe";
const no = () => "";

describe("hlsStrategy", () => {
  it("prefers native HLS when the browser has it", () => {
    // Safari and iOS. Native is not just cheaper here — on iPhone it is the
    // only option, because there is no MSE to run hls.js on.
    expect(hlsStrategy(yes, true)).toBe("native");
  });

  it("uses native HLS with no MSE at all — the iPhone case", () => {
    expect(hlsStrategy(yes, false)).toBe("native");
  });

  it("falls back to hls.js when there is MSE but no native HLS", () => {
    expect(hlsStrategy(no, true)).toBe("mse");
  });

  it("reports unsupported when there is neither", () => {
    expect(hlsStrategy(no, false)).toBe("unsupported");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/static/hlsMount.test.ts`
Expected: FAIL — `Failed to resolve import "./hlsMount"`.

- [ ] **Step 3: Add the dependency**

```bash
npm install hls.js
```

In `tsup.web.config.ts`, extend `noExternal`:

```ts
  noExternal: [/^parse-torrent-title$/, /^hls\.js$/],
```

Without this the build succeeds and emits a bare `import … from "hls.js"` that no browser can resolve, and nothing in the test suite can see it — the reason that array exists at all.

- [ ] **Step 4: Implement**

Create `src/web/static/hlsMount.ts`:

```ts
// Attaching an HLS manifest to a <video>, by whichever route this browser has.
//
// hlsStrategy is the decision and is unit-tested. mountHls is wiring: it loads
// a library and touches the DOM, neither of which a test in this repo can
// reach, so it is kept to the minimum that reading it end to end is enough.
const HLS_MIME = "application/vnd.apple.mpegurl";

export type HlsStrategy = "native" | "mse" | "unsupported";

/**
 * Native HLS first, and not merely as an optimisation.
 *
 * iPhone Safari has no Media Source Extensions, so hls.js cannot run there —
 * but it plays HLS natively from `video.src`. Since the phone is the device this
 * whole page exists for, the native branch is the important one, and preferring
 * it also means Safari never downloads a library it does not need.
 */
export function hlsStrategy(canPlayHls: (type: string) => string, hasMse: boolean): HlsStrategy {
  if (canPlayHls(HLS_MIME) !== "") return "native";
  return hasMse ? "mse" : "unsupported";
}

/** Whether this browser can run hls.js at all. */
export function hasMse(): boolean {
  return typeof window !== "undefined" && "MediaSource" in window;
}

/**
 * Point a `<video>` at an HLS manifest.
 *
 * `hls.js` is imported dynamically so a direct-play mp4 never downloads it —
 * it is by far the largest thing in this bundle. `onError` is called for a
 * fatal error only; hls.js recovers from plenty of non-fatal ones itself, and
 * reporting those would replace a video that is about to play with a card.
 */
export async function mountHls(
  video: HTMLVideoElement,
  manifest: string,
  hooks: { onError: () => void },
): Promise<void> {
  const strategy = hlsStrategy((t) => video.canPlayType(t), hasMse());
  if (strategy === "unsupported") {
    hooks.onError();
    return;
  }
  if (strategy === "native") {
    video.src = manifest;
    return;
  }
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) {
    hooks.onError();
    return;
  }
  const hls = new Hls();
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (data.fatal) {
      hls.destroy();
      hooks.onError();
    }
  });
  hls.loadSource(manifest);
  hls.attachMedia(video);
}
```

- [ ] **Step 5: Replace the placeholder branch in `player.ts`**

`mountVideo` currently builds the element and its own stall/error handling. Split it so the element construction is shared: extract the element setup into `createVideo(): HTMLVideoElement` and the settle/stall logic into a `watch(video, target)` that both rungs use — an HLS mount needs exactly the same "no frame, no error, twelve seconds" detection, and duplicating it is how the two drift.

Then:

```ts
  if (chosen.rung === "provider-hls" && info?.hls) {
    const video = createVideo();
    const settle = watch(video, target);
    stage.replaceChildren(video);
    await mountHls(video, info.hls, { onError: () => settle.fail("error") });
    void video.play().catch(() => {});
    return;
  }
```

- [ ] **Step 6: Turn rung 2 on**

Now that the page can mount a manifest, uncomment the `resolveHls: makeResolveHls({ tokenImpl })` line left in `src/web/server.ts` by Task 8 Step 4, and implement `tokenImpl` as that comment describes. This is the step that makes rung 2 live; before it, `.info` always reported `hls: null` in production even though Task 8's tests covered the branch.

- [ ] **Step 7: Run the tests and the build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass. Check the emitted `dist/web/player.js` does **not** contain a bare `from"hls.js"`:

```bash
grep -c 'from"hls.js"' dist/web/*.js || echo "correctly bundled"
```

hls.js should appear as its own dynamically-imported chunk in `dist/web/`.

- [ ] **Step 8: Run it for real, on two devices**

Run: `npm run dev -- serve --web` with a Real-Debrid token configured. Stream an MKV, open the player.

- On a desktop Chrome or Firefox: it should play via hls.js. Confirm in devtools that the hls.js chunk is fetched only for this file, and not when playing an mp4.
- **On an actual iPhone**, over the LAN URL: it should play via the native branch. This cannot be verified any other way — there is no MSE there, so a desktop pass proves nothing about it.

If the manifest fetch fails with a CORS error in the console, Task 0's finding was wrong or has changed. Stop and report; do not paper over it with a proxy invented on the spot.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsup.web.config.ts src/web/server.ts src/web/static/hlsMount.ts src/web/static/hlsMount.test.ts src/web/static/player.ts
git commit -m "feat: play a provider HLS manifest, natively on iOS and via hls.js elsewhere"
```

---

### Task 10: Tell the truth in the docs

**Files:**
- Modify: `README.md:294`
- Modify: `src/web/index.html` — the web UI's own limitations list, if it repeats the claim

**Interfaces:** none.

- [ ] **Step 1: Find every place that promises MKV will not play**

```bash
grep -rn -i "mkv\|hevc\|dts" README.md src/web/index.html src/web/static/*.ts | cut -c1-140
```

- [ ] **Step 2: Rewrite `README.md:294`**

The current line says mkv, HEVC and DTS will not decode and that the app shows a card rather than a black rectangle. That is now only partly true. The replacement must stay honest about the remaining gap — a local torrent carrying HEVC still needs a real player — and must not promise transcoding on a host with no debrid provider, because this plan does not deliver it. Something in this shape, in the README's own voice:

> **mkv, HEVC, DTS** — most of the scene. No browser demuxes Matroska or decodes DTS, so where your debrid provider will transcode a file, the player uses that and it just plays. Where it won't — a torrent streamed from the swarm, or a file the provider refuses — you still get a card that says so and a one-tap hand-off to a real player, rather than a black rectangle.

- [ ] **Step 3: Check the web UI's limitations list**

If `src/web/index.html` carries its own "what this can't do" copy naming mkv, update it to match. Remember the no-`innerHTML` rule if any of that copy is built in `app.ts`.

- [ ] **Step 4: Commit**

```bash
git add README.md src/web/index.html
git commit -m "docs: the web player now plays what the provider will transcode"
```

---

### Task 11: The PR

- [ ] **Step 1: Run every check one more time**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass, with only the known pre-existing `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx`.

- [ ] **Step 2: Open the PR with the exemption stated**

`CLAUDE.md` requires that a feature landing in only one front end says so in the PR body **with the reason**. The body must contain, in its own words:

> Browser-only, and this is the "a surface can't express it" exemption: the terminal has no `<video>` element, and the TUI's play path already hands the stream URL to mpv, IINA or VLC, all of which demux MKV and decode DTS natively. The problem this solves does not exist in the terminal. The one piece that is shared — `ffprobe`/`ffmpeg` detection — lives in `src/util/ffmpegBin.ts` so a future TUI use does not have to move it.

Also state what is *not* here: rung 3, the local ffmpeg path, so a WebTorrent-streamed MKV still gets the fallback card. Link the follow-up plan.

---

## Self-review notes

- **Spec coverage.** Rung 1 → Tasks 1, 3, 4, 5. Rung 2 → Tasks 0, 6, 7, 8, 9. Rung 4 → unchanged, exercised by Task 5's tests. Classification from both sources → Tasks 1 and 3. ffmpeg detection and fail-soft → Task 2. iOS native HLS → Task 9. Docs and the front-end exemption → Tasks 10 and 11. **Rung 3 is not covered here** and is a separate plan, stated at the top.
- **One deliberate deviation.** The spec's `debridTranscode` flag on `/api/sources` is not built; Task 8 records why (no consumer — `.info` resolves rung 2 server-side).
- **One latency trade decided here, not in the spec.** `.info` probes only files the release name already says are unplayable. Paying a bounded-15s spawn plus network round trip on every player page load — including the mp4 that was going to play instantly — to catch the uncommon mp4-carrying-HEVC is the wrong way round. The cost is that such a file still gets optimism, a decode error and the card, which is exactly its behaviour before this route existed. Task 4 states this in the code comment and tests both directions.
- **One ordering constraint that is a correctness matter, not tidiness.** Task 8 builds `makeResolveHls` but leaves it unwired; Task 9 turns it on. Wiring it earlier would make a debrid MKV with a working manifest show a card claiming its container is unplayable, because Task 5's `provider-hls` branch is still a placeholder until Task 9.
- **One thing the spec did not settle, decided here.** How the player page learns the facts: the page has the capability and not the bearer token, so an `/api/` route is unreachable to it. Task 4 makes `.info` a representation of the stream handle, behind the same single guard chain as `.m3u`.
- **Naming consistency.** `MediaFacts`, `Blocker`, `blockersFor`, `classifyFromName`, `extensionOf`, `probeUrl`, `ProbeCache`, `splitRepresentation`, `StreamInfoResponse`, `chooseSource`, `Rung`, `infoPath`, `makeResolveHls`, `transcodeManifest`, `hlsStrategy`, `mountHls` — each defined in exactly one task and referenced by that name everywhere after.
