# Web Player: Local HLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rung 3 of the source ladder in `docs/superpowers/specs/2026-07-31-web-player-hard-containers-design.md` — a local `ffmpeg` remuxes an MKV into fragmented-MP4 HLS, re-encoding only the audio, so the web player plays it. This is the rung that works with **no debrid account at all**, on the WebTorrent backend.

**Architecture:** A transcode session registry mirroring `StreamSessionRegistry`: one `ffmpeg` process and one temp segment directory per (session, file), started on demand, reference-counted, reaped when idle. A new route family `/hls/:sid/:idx/:file?k=` serves the playlist and segments through the *same* authorisation guard as `/stream/:sid/:idx` — extracted into a shared function so there is one guard rather than three. `/stream/:sid/:idx` and its Range-forwarding proxy are not touched.

**Tech Stack:** TypeScript, Node 22+, vitest, `ffmpeg` (detected via `src/util/ffmpegBin.ts`, never required).

**Depends on:** `2026-07-31-web-player-classification-and-provider-transcode.md`, all tasks. This plan consumes `findFfmpeg`, `MediaFacts`, `blockersFor`, the `.info` route, `chooseSource` and `mountHls` from it.

## Global Constraints

Every task's requirements implicitly include all of these.

- **`src/web` must not import from `src/ui`; `src/core` must not import from `src/ui` or `src/web`.** Enforced by `eslint.config.js`.
- **No `node:*` imports reachable from `src/web/static/`.** `npm run build` is the only check.
- **Anything deciding *what to show* or *what to send* lives in a pure module,** not in `player.ts` or `app.ts`.
- **`ffmpeg` is detected, never required.** Absent means rung 3 does not exist and the ladder falls to the card — today's behaviour. No new npm dependency, nothing downloaded in `postinstall`.
- **Never log a debrid unrestricted link or a capability.** Both are credentials, and an ffmpeg command line contains the former.
- **Test fixtures name invented films and shows, never real ones:** `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`.
- **`ffmpeg` is never executed by the test suite.** The process boundary is injected, as `streamTorrentImpl` and `resolveDebridImpl` already are on `StreamSessionDeps`.
- **Before saying a task is done:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Leave the known `react-hooks/exhaustive-deps` warning in `src/ui/App.tsx`.
- **Conventional Commits.**

## An accepted limitation, decided up front

ffmpeg writes a **growing event playlist** (`-hls_playlist_type event`), not a VOD one. Consequences, which the plan does not try to hide:

- You can play from the start immediately and scrub freely within what has been produced.
- The scrub bar's duration **grows** as the transcode advances; it does not show the film's full length from the first second.
- Seeking past the transcoded point is not possible until the transcode gets there.

The alternative — a static VOD playlist over segments transcoded on demand from a seek point, which is how Jellyfin does it — gives full seeking from the first second and is several times this plan's size. It is not worth it yet, because a `-c:v copy` remux runs far faster than real time: the read is the bottleneck, so a debrid-backed file converges in a couple of minutes and a torrent converges as fast as it downloads. **Task 6 measures this on a real file and records the number**, and if it turns out slow enough to be unusable, that measurement is the argument for building the VOD design rather than a guess.

---

### Task 1: One authorisation guard for every representation

**Files:**
- Modify: `src/web/stream.ts` — extract the guard chain out of `handleStreamRequest`
- Modify: `src/web/stream.test.ts`

`handleStreamRequest` currently does session lookup → capability check → readiness check → bounds check inline, and its own comment says these must be one guard and not several, because a representation that skipped the capability check would hand out a playable URL to anyone who guessed a session id. A third route family is about to need the same four checks, so it is extracted now rather than copied.

**Interfaces:**
- Produces in `src/web/stream.ts`:
  - `type StreamGuardResult = { ok: true; session: StreamSession; file: StreamFile; index: number } | { ok: false; status: 401 | 404; error: string }`
  - `function authorizeStreamFile(sessions: StreamSessionRegistry, sid: string, index: number, k: string | null): StreamGuardResult`

- [ ] **Step 1: Write the failing test**

Add to `src/web/stream.test.ts`, calling the function directly — it is pure given a registry, so it does not need the HTTP harness:

```ts
describe("authorizeStreamFile", () => {
  it("rejects an unknown session with 404", () => {
    const r = authorizeStreamFile(registry(), "nope", 0, "cap-1");
    expect(r).toEqual({ ok: false, status: 404, error: "unknown session" });
  });

  it("rejects a missing capability with 401", () => {
    const { sessions, sid } = readySession();
    expect(authorizeStreamFile(sessions, sid, 0, null)).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a wrong capability with 401", () => {
    const { sessions, sid } = readySession();
    expect(authorizeStreamFile(sessions, sid, 0, "wrong")).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a session with an empty capability, rather than treating it as open", () => {
    // isAuthorized treats a falsy expected token as "no auth configured" and
    // returns true, which is right for the server-wide token and catastrophic
    // here. This test is the guard on that guard.
    const { sessions, sid } = readySession({ capability: "" });
    expect(authorizeStreamFile(sessions, sid, 0, "")).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a session that is still resolving with 404", () => {
    const { sessions, sid } = readySession({ state: "resolving", files: [] });
    expect(authorizeStreamFile(sessions, sid, 0, "cap-1")).toMatchObject({ ok: false, status: 404 });
  });

  it("rejects an index past the end with 404", () => {
    const { sessions, sid } = readySession();
    expect(authorizeStreamFile(sessions, sid, 99, "cap-1")).toMatchObject({ ok: false, status: 404 });
  });

  it("returns the session and the file when everything checks out", () => {
    const { sessions, sid } = readySession();
    const r = authorizeStreamFile(sessions, sid, 0, "cap-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.filename).toBe("Kestrel.2010.1080p.BluRay.x264.mkv");
  });
});
```

Build `registry()` and `readySession()` from whatever the file already uses to construct a registry with a ready session; do not add a second way of doing it.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/stream.test.ts`
Expected: FAIL — `authorizeStreamFile` is not exported.

- [ ] **Step 3: Extract it**

In `src/web/stream.ts`, move the four checks out of `handleStreamRequest` into:

```ts
export type StreamGuardResult =
  | { ok: true; session: StreamSession; file: StreamFile; index: number }
  | { ok: false; status: 401 | 404; error: string };

/**
 * The one authorisation guard for everything that addresses a session's file.
 *
 * Media, `.m3u`, `.info` and the HLS routes all go through this and nothing
 * else. Any representation that grew its own copy of these four checks would
 * eventually skip one, and the one it skips is the capability — which would
 * hand out a playable URL to anyone who guessed a session id.
 *
 * An unknown id is 404 before the capability is looked at, because there is no
 * capability to compare against yet. That makes this an existence oracle for
 * session ids, acceptable only because ids are random UUIDs and the 401 branch
 * leaks nothing further.
 */
export function authorizeStreamFile(
  sessions: StreamSessionRegistry,
  sid: string,
  index: number,
  k: string | null,
): StreamGuardResult {
  const session = sessions.get(sid);
  if (!session) return { ok: false, status: 404, error: "unknown session" };

  // isAuthorized rather than `===` for its constant-time compare, and because a
  // second hand-rolled token comparison is a second place to get it wrong. The
  // empty-capability guard is load-bearing: isAuthorized treats a falsy expected
  // token as "no auth configured" and returns true.
  if (!session.capability || !isAuthorized(session.capability, k ? `Bearer ${k}` : undefined)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const file = session.files[index];
  // A session still resolving has no files and an errored one never will. Both
  // are 404 rather than 409/500: the handle simply does not address anything
  // yet, and a <video> element does nothing useful with a status either way.
  if (!file) return { ok: false, status: 404, error: "not found" };

  return { ok: true, session, file, index };
}
```

Rewrite `handleStreamRequest` to call it and write `writeJson(res, r.status, { error: r.error })` on failure. **Do not change any status code or response body** — the existing tests in this file are the check that the extraction was behaviour-preserving, and one of them asserting a different code now means the refactor was wrong, not that the test is stale.

- [ ] **Step 4: Run the whole stream suite**

Run: `npx vitest run src/web/stream.test.ts src/web/server.test.ts`
Expected: PASS, including every pre-existing test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/web/stream.ts src/web/stream.test.ts
git commit -m "refactor: one authorisation guard for every stream representation"
```

---

### Task 2: The ffmpeg command line

**Files:**
- Create: `src/core/transcodeArgs.ts`
- Create: `src/core/transcodeArgs.test.ts`

Pure, so the decisions that matter are testable without running anything.

**Interfaces:**
- Consumes: `MediaFacts` from `src/util/playability.ts`.
- Produces:
  - `const HLS_PLAYLIST = "index.m3u8"`, `const HLS_INIT = "init.mp4"`
  - `function canRemux(facts: MediaFacts): boolean`
  - `function transcodeArgs(input: string, dir: string, facts: MediaFacts): string[]`
  - `function isSegmentName(name: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/core/transcodeArgs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canRemux, isSegmentName, transcodeArgs } from "./transcodeArgs";
import type { MediaFacts } from "../util/playability";

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  container: "mkv",
  videoCodec: "h264",
  audioCodec: "dts",
  source: "probe",
  ...over,
});

describe("canRemux", () => {
  it("accepts h264 video, whatever the audio", () => {
    expect(canRemux(facts())).toBe(true);
    expect(canRemux(facts({ audioCodec: "truehd" }))).toBe(true);
  });

  it("refuses hevc — a video re-encode is out of scope", () => {
    expect(canRemux(facts({ videoCodec: "hevc" }))).toBe(false);
  });

  it("refuses av1 and mpeg2 for the same reason", () => {
    expect(canRemux(facts({ videoCodec: "av1" }))).toBe(false);
    expect(canRemux(facts({ videoCodec: "mpeg2" }))).toBe(false);
  });

  it("refuses an unknown video codec", () => {
    // Unknown here is not the same as unknown in blockersFor. There, optimism
    // costs a card; here it costs an ffmpeg process producing garbage nobody
    // can play, held open against a torrent.
    expect(canRemux(facts({ videoCodec: "" }))).toBe(false);
  });

  it("accepts vp9, which browsers decode but not from matroska", () => {
    expect(canRemux(facts({ videoCodec: "vp9" }))).toBe(true);
  });
});

describe("transcodeArgs", () => {
  const args = transcodeArgs("https://cdn.example/Kestrel.mkv", "/tmp/t1", facts());
  const joined = args.join(" ");

  it("copies the video and never re-encodes it", () => {
    expect(joined).toContain("-c:v copy");
    expect(joined).not.toContain("libx264");
  });

  it("re-encodes the audio to stereo aac", () => {
    expect(joined).toContain("-c:a aac");
    expect(joined).toContain("-ac 2");
  });

  it("copies audio that is already browser-safe", () => {
    const safe = transcodeArgs("https://cdn.example/a.mkv", "/tmp/t1", facts({ audioCodec: "aac" })).join(" ");
    expect(safe).toContain("-c:a copy");
    expect(safe).not.toContain("-c:a aac");
  });

  it("writes fragmented mp4 hls into the given directory", () => {
    expect(joined).toContain("-hls_segment_type fmp4");
    expect(args[args.length - 1]).toBe("/tmp/t1/index.m3u8");
  });

  it("uses an event playlist, so playback can start before the transcode ends", () => {
    expect(joined).toContain("-hls_playlist_type event");
  });

  it("drops subtitles, chapters and data streams", () => {
    // A browser cannot render an embedded subtitle track from HLS anyway, and a
    // font attachment in an mkv will make the muxer fail outright.
    expect(joined).toContain("-sn");
    expect(joined).toContain("-dn");
  });

  it("never reads stdin, so a stalled process cannot wait on a prompt forever", () => {
    expect(args).toContain("-nostdin");
  });

  it("passes the input url as one argv element, never through a shell", () => {
    const weird = transcodeArgs("https://cdn.example/a b;rm -rf.mkv", "/tmp/t1", facts());
    expect(weird).toContain("https://cdn.example/a b;rm -rf.mkv");
  });
});

describe("isSegmentName", () => {
  it("accepts the playlist, the init segment and a numbered segment", () => {
    expect(isSegmentName("index.m3u8")).toBe(true);
    expect(isSegmentName("init.mp4")).toBe(true);
    expect(isSegmentName("seg00042.m4s")).toBe(true);
  });

  it("rejects traversal", () => {
    expect(isSegmentName("../../../etc/passwd")).toBe(false);
    expect(isSegmentName("..%2Fetc%2Fpasswd")).toBe(false);
    expect(isSegmentName("/etc/passwd")).toBe(false);
    expect(isSegmentName("sub/seg00001.m4s")).toBe(false);
  });

  it("rejects a name that merely looks close", () => {
    expect(isSegmentName("seg1.m4s")).toBe(false);
    expect(isSegmentName("index.m3u8.bak")).toBe(false);
    expect(isSegmentName("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/transcodeArgs.test.ts`
Expected: FAIL — `Failed to resolve import "./transcodeArgs"`.

- [ ] **Step 3: Implement**

Create `src/core/transcodeArgs.ts`:

```ts
// The ffmpeg command line for rung 3, and the rules about what it writes.
//
// Pure: no spawning, no filesystem. The interesting decisions — is this file
// remuxable at all, does the audio need re-encoding, what may a client ask for
// out of the output directory — are all here where a test can reach them.
import type { MediaFacts } from "../util/playability";

export const HLS_PLAYLIST = "index.m3u8";
export const HLS_INIT = "init.mp4";

// Four seconds: short enough that playback starts promptly, long enough that a
// two-hour film is ~1800 segments rather than ~7000 files in one directory.
const SEGMENT_SECONDS = "4";

// Video codecs a browser decodes, which we can therefore stream-copy straight
// into fMP4. Anything else would need a real re-encode, which this rung does
// not do — see the spec's scope section.
const REMUXABLE_VIDEO = new Set(["h264", "vp8", "vp9"]);

// Audio a browser decodes. Everything else becomes stereo AAC, which is the
// cheap half of this rung and the reason it covers most of the scene.
const SAFE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/**
 * Whether rung 3 can serve this file at all.
 *
 * An unknown video codec is refused, unlike in `blockersFor`. The asymmetry is
 * deliberate: there, optimism costs a fallback card, which is cheap and
 * recoverable. Here it costs an ffmpeg process producing output nobody can play,
 * holding a torrent open and burning a CPU until something reaps it.
 */
export function canRemux(facts: MediaFacts): boolean {
  return REMUXABLE_VIDEO.has(facts.videoCodec);
}

/**
 * The argv to remux one input into HLS in `dir`.
 *
 * `input` is a URL — a debrid link or the local WebTorrent server's — and is
 * always a single argv element. It is attacker-influenced (built from a
 * torrent's filename) and must never reach a shell.
 *
 * `-hls_playlist_type event` rather than `vod`: a VOD playlist cannot be written
 * until the transcode finishes, which would mean waiting for the whole film
 * before the first frame. The cost is that the scrub bar's duration grows as
 * the transcode advances. See this plan's header for why that trade is accepted.
 */
export function transcodeArgs(input: string, dir: string, facts: MediaFacts): string[] {
  const audioCopy = SAFE_AUDIO.has(facts.audioCodec);
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:v:0",
    // `?` makes the audio stream optional: a video with no audio track at all
    // must still remux rather than failing the whole command.
    "-map",
    "0:a:0?",
    "-c:v",
    "copy",
    ...(audioCopy ? ["-c:a", "copy"] : ["-c:a", "aac", "-ac", "2", "-b:a", "256k"]),
    // Subtitles a browser cannot render from HLS, data streams, and chapters.
    // The font attachments in an mkv will make the mp4 muxer fail outright if
    // they are not dropped, which reads as "ffmpeg is broken" when it isn't.
    "-sn",
    "-dn",
    "-map_chapters",
    "-1",
    "-f",
    "hls",
    "-hls_time",
    SEGMENT_SECONDS,
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    HLS_INIT,
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    `${dir}/seg%05d.m4s`,
    `${dir}/${HLS_PLAYLIST}`,
  ];
}

// Exactly the three shapes ffmpeg is told to write above, anchored, and nothing
// else. This is the only thing between a client-supplied path component and a
// read off the disk, so it is an allow-list of literals and one numeric pattern
// rather than any kind of sanitising.
const SEGMENT_RE = /^seg\d{5}\.m4s$/;

export function isSegmentName(name: string): boolean {
  return name === HLS_PLAYLIST || name === HLS_INIT || SEGMENT_RE.test(name);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/core/transcodeArgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/transcodeArgs.ts src/core/transcodeArgs.test.ts
git commit -m "feat: build the ffmpeg argv for an HLS remux"
```

---

### Task 3: The transcode session registry

**Files:**
- Create: `src/core/transcodeSession.ts`
- Create: `src/core/transcodeSession.test.ts`

Mirrors `StreamSessionRegistry` in `src/core/streamSession.ts`: owns live work for the whole process, with the process boundary injected so the suite never spawns anything.

**The failure this must not have** is a leaked ffmpeg pulling a torrent forever after the tab closed.

**Interfaces:**
- Consumes: `transcodeArgs`, `canRemux`, `HLS_PLAYLIST` (Task 2); `findFfmpeg` from `src/util/ffmpegBin.ts`; `MediaFacts`.
- Produces:
  - `interface TranscodeProc { kill(): void; readonly exited: Promise<number | null> }`
  - `type SpawnTranscode = (bin: string, args: string[]) => TranscodeProc`
  - `interface TranscodeDeps { spawnImpl?: SpawnTranscode; findFfmpegImpl?: () => Promise<string | null>; mkdtempImpl?: () => Promise<string>; rmImpl?: (dir: string) => Promise<void>; now?: () => number; idleMs?: number }`
  - `type AcquireResult = { ok: true; dir: string } | { ok: false; reason: "no-ffmpeg" | "not-remuxable" }`
  - `class TranscodeRegistry { acquire(sid, index, input, facts): Promise<AcquireResult>; touch(sid, index): void; dirFor(sid, index): string | null; reapIdle(): Promise<void>; release(sid): Promise<void>; releaseAll(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Create `src/core/transcodeSession.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { TranscodeRegistry, type TranscodeDeps, type TranscodeProc } from "./transcodeSession";
import type { MediaFacts } from "../util/playability";

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  container: "mkv",
  videoCodec: "h264",
  audioCodec: "dts",
  source: "probe",
  ...over,
});

function harness(over: Partial<TranscodeDeps> = {}) {
  const spawned: { bin: string; args: string[] }[] = [];
  const killed: number[] = [];
  const removed: string[] = [];
  let clock = 0;
  let dirs = 0;
  const deps: TranscodeDeps = {
    findFfmpegImpl: async () => "ffmpeg",
    mkdtempImpl: async () => `/tmp/torlnk-${dirs++}`,
    rmImpl: async (dir) => {
      removed.push(dir);
    },
    spawnImpl: (bin, args) => {
      const id = spawned.length;
      spawned.push({ bin, args });
      const proc: TranscodeProc = {
        kill: () => killed.push(id),
        exited: new Promise(() => {}),
      };
      return proc;
    },
    now: () => clock,
    idleMs: 100,
    ...over,
  };
  return {
    registry: new TranscodeRegistry(deps),
    spawned,
    killed,
    removed,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("TranscodeRegistry.acquire", () => {
  it("refuses when there is no ffmpeg, without making a directory", async () => {
    const h = harness({ findFfmpegImpl: async () => null });
    const r = await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    expect(r).toEqual({ ok: false, reason: "no-ffmpeg" });
    expect(h.spawned).toHaveLength(0);
  });

  it("refuses a file it cannot remux", async () => {
    const h = harness();
    const r = await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts({ videoCodec: "hevc" }));
    expect(r).toEqual({ ok: false, reason: "not-remuxable" });
    expect(h.spawned).toHaveLength(0);
  });

  it("spawns ffmpeg once and returns its directory", async () => {
    const h = harness();
    const r = await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    expect(r).toEqual({ ok: true, dir: "/tmp/torlnk-0" });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.args).toContain("-c:v");
  });

  it("reuses the running process for the same file", async () => {
    const h = harness();
    await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    const again = await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    expect(again).toEqual({ ok: true, dir: "/tmp/torlnk-0" });
    expect(h.spawned).toHaveLength(1);
  });

  it("runs a second process for a different file in the same session", async () => {
    const h = harness();
    await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    await h.registry.acquire("sid-1", 1, "https://cdn.example/b.mkv", facts());
    expect(h.spawned).toHaveLength(2);
  });

  it("does not spawn twice when two requests race", async () => {
    // Two <video> elements, or a reload mid-start. The second caller must join
    // the first rather than starting a competing ffmpeg on the same directory.
    const h = harness();
    const [a, b] = await Promise.all([
      h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts()),
      h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts()),
    ]);
    expect(a).toEqual(b);
    expect(h.spawned).toHaveLength(1);
  });
});

describe("TranscodeRegistry reaping", () => {
  it("kills and removes a session with no requests for the idle window", async () => {
    const h = harness();
    await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    h.tick(101);
    await h.registry.reapIdle();
    expect(h.killed).toEqual([0]);
    expect(h.removed).toEqual(["/tmp/torlnk-0"]);
    expect(h.registry.dirFor("sid-1", 0)).toBeNull();
  });

  it("keeps a session that was touched inside the window", async () => {
    const h = harness();
    await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    h.tick(80);
    h.registry.touch("sid-1", 0);
    h.tick(80);
    await h.registry.reapIdle();
    expect(h.killed).toEqual([]);
  });

  it("release kills every file of one session", async () => {
    const h = harness();
    await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    await h.registry.acquire("sid-1", 1, "https://cdn.example/b.mkv", facts());
    await h.registry.acquire("sid-2", 0, "https://cdn.example/c.mkv", facts());
    await h.registry.release("sid-1");
    expect(h.killed).toEqual([0, 1]);
    expect(h.registry.dirFor("sid-2", 0)).toBe("/tmp/torlnk-2");
  });

  it("releaseAll leaves nothing running", async () => {
    const h = harness();
    await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    await h.registry.acquire("sid-2", 0, "https://cdn.example/b.mkv", facts());
    await h.registry.releaseAll();
    expect(h.killed).toEqual([0, 1]);
    expect(h.removed).toHaveLength(2);
  });

  it("removes the directory even when the kill throws", async () => {
    // A process that already exited throws on kill on some platforms. Leaking
    // the directory because of that is the leak this whole class exists to
    // avoid.
    const h = harness({
      spawnImpl: () => ({
        kill: () => {
          throw new Error("ESRCH");
        },
        exited: Promise.resolve(0),
      }),
    });
    await h.registry.acquire("sid-1", 0, "https://cdn.example/a.mkv", facts());
    await h.registry.releaseAll();
    expect(h.removed).toEqual(["/tmp/torlnk-0"]);
  });

  it("does not confuse a session id containing the key separator", () => {
    const h = harness();
    expect(h.registry.dirFor("a:1", 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/transcodeSession.test.ts`
Expected: FAIL — `Failed to resolve import "./transcodeSession"`.

- [ ] **Step 3: Implement**

Create `src/core/transcodeSession.ts`. Key requirements the tests above pin down, all of which are the interesting part:

- Key by `JSON.stringify([sid, index])`, for the reason `ProbeCache` does.
- Store the **in-flight promise** in the map before awaiting anything, so two racing `acquire` calls join rather than both spawning. This is the bug the race test exists for.
- `mkdtempImpl` defaults to `fs.mkdtemp(path.join(os.tmpdir(), "torlnk-hls-"))`.
- `spawnImpl` defaults to a `spawn(bin, args, { windowsHide: true })` wrapper exposing `kill()` and an `exited` promise. **Never `shell: true`** — the input URL is attacker-influenced.
- `reapIdle` compares `now() - lastTouch` against `idleMs` (default 60_000) and tears down anything past it.
- Teardown is always kill-then-remove, with the kill wrapped in `try/catch` so a throwing kill cannot skip the directory removal.
- When a process exits on its own, keep the directory: the transcode completing is the *success* case and its segments are still being served. Only reaping and `release` remove it.
- `acquire` calls `canRemux(facts)` before `findFfmpeg`, so an HEVC file never even looks for a binary.

Wire `reapIdle` to a `setInterval` owned by the caller (Task 4), not by this class — a class that starts its own timer cannot be constructed in a test without leaking one.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/core/transcodeSession.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/transcodeSession.ts src/core/transcodeSession.test.ts
git commit -m "feat: a reference-counted registry for local HLS transcodes"
```

---

### Task 4: Serve `/hls/:sid/:idx/:file?k=`

**Files:**
- Create: `src/web/hls.ts`
- Create: `src/web/hls.test.ts`
- Modify: `src/web/server.ts` — mount the route, own the reap timer, tear down on close
- Modify: `src/web/stream.ts` — `.info` reports whether rung 3 is available

**Interfaces:**
- Consumes: `authorizeStreamFile` (Task 1), `isSegmentName`, `HLS_PLAYLIST` (Task 2), `TranscodeRegistry` (Task 3).
- Produces:
  - `function isHlsPath(urlPath: string): boolean`
  - `function parseHlsPath(urlPath: string): { sid: string; index: number; file: string } | null`
  - `async function handleHlsRequest(deps, req, res, urlPath, query): Promise<number>`
  - `StreamInfoResponse` gains `localHls: string | null` — the playlist URL to use, or null

- [ ] **Step 1: Write the failing test**

Create `src/web/hls.test.ts`. Stand up a real `http.Server`, as `src/web/stream.test.ts` does and for the same reason — segment delivery and its auth are HTTP behaviour. Write the fixture segment files to a temp dir yourself and have a fake registry return it; ffmpeg is never run.

```ts
describe("parseHlsPath", () => {
  it("reads the session, index and file", () => {
    expect(parseHlsPath("/hls/abc/3/seg00001.m4s")).toEqual({ sid: "abc", index: 3, file: "seg00001.m4s" });
  });

  it("decodes an encoded session id", () => {
    expect(parseHlsPath("/hls/a%2Fb/0/index.m3u8")?.sid).toBe("a/b");
  });

  it("rejects an index that is not a plain integer", () => {
    // Same grammar as parseStreamPath, deliberately: one address written twice
    // that disagreed would 404 in one place and serve in the other.
    expect(parseHlsPath("/hls/abc/-1/index.m3u8")).toBeNull();
    expect(parseHlsPath("/hls/abc/1.5/index.m3u8")).toBeNull();
  });

  it("rejects a nested path", () => {
    expect(parseHlsPath("/hls/abc/0/a/b.m4s")).toBeNull();
  });
});

describe("handleHlsRequest", () => {
  it("401s without the capability", async () => { /* expect 401 */ });

  it("401s before it starts a transcode", async () => {
    // The expensive thing must be behind the guard, not beside it: otherwise a
    // guessed session id spins up ffmpeg against someone's torrent.
    let acquired = 0;
    // ...expect(acquired).toBe(0)
  });

  it("404s an unknown session and an out-of-range index", async () => { /* 404, 404 */ });

  it("404s a file name that is not one ffmpeg writes", async () => {
    for (const name of ["../../etc/passwd", "%2e%2e%2fetc%2fpasswd", "seg1.m4s", "index.m3u8.bak"]) {
      // expect 404, and expect no read outside the transcode directory
    }
  });

  it("serves the playlist with the HLS content type", async () => {
    // expect content-type application/vnd.apple.mpegurl
  });

  it("serves a segment with the fmp4 content type", async () => {
    // expect content-type video/iso.segment or video/mp4
  });

  it("503s with Retry-After while the playlist does not exist yet", async () => {
    // ffmpeg has started but has not written index.m3u8. A 404 here would make
    // hls.js give up permanently; a 503 with Retry-After makes it come back.
  });

  it("503s rather than 500 when there is no ffmpeg on the host", async () => {
    // expect status 503 and a body naming the reason, never a stack trace
  });

  it("touches the registry on every request, so playing does not look idle", async () => {
    // expect touched >= 1 after a segment request
  });

  it("never writes the upstream url or the capability into the response", async () => {
    // expect(text).not.toContain("secret-token")
  });
});
```

Fill in each body against the real `serve()`-style harness; the assertions above are the contract and none of them may be dropped. The traversal test in particular must assert the *response*, not just the parse — a 404 from `isSegmentName` and a 404 from a missing file look the same to a test that only checks the status, so also assert that no path outside the transcode directory was read (inject the read).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/hls.test.ts`
Expected: FAIL — `Failed to resolve import "./hls"`.

- [ ] **Step 3: Implement the route**

Create `src/web/hls.ts`, mirroring `src/web/stream.ts`'s structure: `isHlsPath`, `parseHlsPath` with the same `\d+` index grammar, and `handleHlsRequest` that

1. rejects a method other than GET/HEAD with 405,
2. parses the path, 404 if it does not parse,
3. **runs `authorizeStreamFile` before anything expensive**,
4. rejects a `file` failing `isSegmentName` with 404,
5. `acquire`s the transcode — mapping `no-ffmpeg` and `not-remuxable` to 503 with a short JSON body — then `touch`es it,
6. serves `path.join(dir, file)` with the right content type, streaming with `fs.createReadStream`,
7. answers 503 with `Retry-After: 1` when the file does not exist yet, because ffmpeg has not written it. A 404 makes hls.js give up permanently; a 503 makes it retry, which is what a growing playlist needs.

Then in `src/web/stream.ts`'s `.info` branch, add the rung-3 availability field. It must not start a transcode — `.info` is a page load and spawning ffmpeg from it would start one for every player page opened:

```ts
    // Availability only: whether rung 3 *could* serve this, not a started
    // transcode. The transcode starts when the browser asks for the playlist.
    const localHls =
      deps.hlsAvailable && (await deps.hlsAvailable(facts)) ? hlsPlaylistPath(parsed.sid, parsed.index) : null;
```

with `hlsAvailable` on `StreamDeps` defaulting to `async (facts) => canRemux(facts) && (await findFfmpeg()) !== null`, and `hlsPlaylistPath` a small exported helper in `src/web/hls.ts` producing `/hls/:sid/:idx/index.m3u8` — no capability in it; the client appends its own, exactly as it does for `/stream/`.

- [ ] **Step 4: Mount it and own its lifecycle in `server.ts`**

- Route `isHlsPath(urlPath)` to `handleHlsRequest`, beside the existing `isStreamPath` branch and outside `handleWebApi` for the same reason: this owns its socket.
- Construct one `TranscodeRegistry` per process.
- Start one `setInterval(() => void registry.reapIdle(), 30_000)`, `unref()`ed so it cannot hold the process open, and clear it on server close.
- On server close, `await registry.releaseAll()`. **This is the leak that matters**: without it, `Ctrl-C` on `serve --web` leaves an ffmpeg pulling a torrent.
- When a stream session is removed from `StreamSessionRegistry`, call `registry.release(sid)`. If the registry has no removal hook, add one — a session ending while its transcode runs is the ordinary case, not an edge case.

- [ ] **Step 5: Add the server-level test**

In `src/web/server.test.ts`:

```ts
it("stops every transcode when the server closes", async () => {
  // expect releaseAll to have been called, with an injected registry
});

it("stops a session's transcode when the session is removed", async () => {
  // expect release(sid) to have been called
});
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/web/hls.ts src/web/hls.test.ts src/web/stream.ts src/web/stream.test.ts src/web/server.ts src/web/server.test.ts src/web/wire.ts
git commit -m "feat: serve a local HLS remux at /hls/:sid/:idx"
```

---

### Task 5: Put rung 3 on the ladder

**Files:**
- Modify: `src/web/static/playerModel.ts` — `Rung` gains `"local-hls"`; `chooseSource` handles it
- Modify: `src/web/static/playerModel.test.ts`
- Modify: `src/web/static/player.ts` — the new branch

**Interfaces:**
- Produces: `type Rung = "direct" | "provider-hls" | "local-hls" | "card"`

- [ ] **Step 1: Write the failing test**

Add to `src/web/static/playerModel.test.ts`:

```ts
describe("chooseSource with a local HLS option", () => {
  it("prefers the provider's manifest over a local transcode", () => {
    // The provider costs this machine nothing. A local remux costs it CPU and
    // full bitrate in and out, which matters most for the viewer who is not on
    // the LAN.
    const chosen = chooseSource(
      info({ blockers: ["container"], hls: "https://rd.example/x.m3u8", localHls: "/hls/sid-1/0/index.m3u8" }),
      "Kestrel.2010.1080p.BluRay.x264.mkv",
    );
    expect(chosen.rung).toBe("provider-hls");
  });

  it("uses the local transcode when there is no provider manifest", () => {
    const chosen = chooseSource(
      info({ blockers: ["container"], hls: null, localHls: "/hls/sid-1/0/index.m3u8" }),
      "Kestrel.2010.1080p.BluRay.x264.mkv",
    );
    expect(chosen).toEqual({ rung: "local-hls", reason: null });
  });

  it("still prefers direct play over any transcode", () => {
    const chosen = chooseSource(
      info({ hls: "https://rd.example/x.m3u8", localHls: "/hls/sid-1/0/index.m3u8" }),
      "Ashfall.1999.1080p.mp4",
    );
    expect(chosen.rung).toBe("direct");
  });

  it("falls to the card when neither transcode is offered", () => {
    const chosen = chooseSource(
      info({ facts: { container: "mkv", videoCodec: "hevc", audioCodec: "dts", source: "probe" }, blockers: ["container", "video", "audio"], hls: null, localHls: null }),
      "Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP.mkv",
    );
    expect(chosen).toEqual({ rung: "card", reason: "container" });
  });
});
```

Extend the file's `info()` helper with `localHls: null` as its default so every existing case is unchanged.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/static/playerModel.test.ts`
Expected: FAIL — `chooseSource` returns `card` where `local-hls` is expected.

- [ ] **Step 3: Implement**

In `chooseSource`, between the provider branch and the card:

```ts
  if (info?.hls) return { rung: "provider-hls", reason: null };
  // Rung 3. Below the provider because a local remux costs this machine CPU and
  // full bitrate both ways, where the provider's costs it nothing — and above
  // the card because it is the only rung a user with no debrid account has.
  if (info?.localHls) return { rung: "local-hls", reason: null };
```

- [ ] **Step 4: Wire it in `player.ts`**

The `local-hls` branch is the `provider-hls` branch with a different URL — `absoluteUrl(location.origin, …)` plus the capability, since a local path needs the `?k=` a provider URL does not. Extract the shared mount into one local function taking a manifest URL rather than writing the block twice; the two rungs differing only in a URL is exactly the copy-then-drift shape this codebase keeps getting bitten by.

The manifest URL must carry the capability:

```ts
export function localHlsUrl(path: string, capability: string): string {
  return capability ? `${path}?k=${encodeURIComponent(capability)}` : path;
}
```

Put it in `playerModel.ts` with a test, not inline in `player.ts` — it builds *what to send*.

**hls.js and the capability:** hls.js resolves segment URLs relative to the playlist, so a `?k=` on the playlist is **not** inherited by the segments in it. Verify in step 6 whether segments 401. If they do, the fix is `xhrSetup` on the hls.js config appending `?k=` to each request, and the native-HLS path needs the query on the playlist plus relative segment URIs that carry it — which means the playlist ffmpeg writes has to be rewritten on the way out by `handleHlsRequest`, appending `?k=` to each segment line. Write that as a pure function in `src/web/hls.ts` with its own tests if it turns out to be needed:

```ts
export function withCapability(playlist: string, capability: string): string
```

- [ ] **Step 5: Run the tests**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

- [ ] **Step 6: Run it for real, and this is the task's real test**

Run: `npm run dev -- serve --web` on a host that has ffmpeg.

- Stream an MKV **from the swarm, with no debrid token configured** — that is the case this whole plan exists for — and open the player. It must play.
- Confirm segments do not 401. If they do, implement `withCapability` as described in step 4 and re-test both the hls.js and native paths.
- On an **iPhone**, over the LAN URL, confirm the native-HLS branch plays it.
- Close the tab, wait past the idle window, and confirm with `ps` that no `ffmpeg` is left running. Then `Ctrl-C` the server with a transcode in flight and confirm the same.

- [ ] **Step 7: Commit**

```bash
git add src/web/static/playerModel.ts src/web/static/playerModel.test.ts src/web/static/player.ts src/web/hls.ts src/web/hls.test.ts
git commit -m "feat: play a locally remuxed MKV in the browser"
```

---

### Task 6: Measure it, then document what is true

**Files:**
- Modify: `README.md`
- Modify: this plan file — record the measurement

The header of this plan accepts a growing scrub bar on the argument that a `-c:v copy` remux runs far faster than real time. That argument is currently unmeasured, and it decides whether the VOD-playlist design is needed.

- [ ] **Step 1: Measure the convergence**

With a ~2 hour 1080p H.264 MKV, on both backends if you have both:

```bash
# while the player is open, watch the playlist grow
watch -n5 'grep -c EXTINF /tmp/torlnk-hls-*/index.m3u8'
```

Record: seconds until the playlist covers the full duration, for a debrid-backed file and for a torrent-backed one. Write both numbers into this file.

- [ ] **Step 2: Decide, in writing**

- Converges in a few minutes → the accepted limitation stands. Say so here and move on.
- Takes long enough that the scrub bar is unusable for most of a viewing → **say so plainly and file the VOD-playlist design as a follow-up**, rather than leaving a limitation nobody warned the user about. Do not silently ship it as fine.

- [ ] **Step 3: Update the README**

The previous plan's README wording covers "where your debrid provider will transcode". It now needs to cover the local path too, and stay honest about the one remaining gap — **HEVC and AV1 video still need a real player, on any backend without a provider transcode**. Do not write anything that implies 4K HEVC plays locally. Mention that transcoding needs `ffmpeg` on the host and that torlnk does not install it.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/plans/2026-07-31-web-player-local-hls.md
git commit -m "docs: what the web player can and cannot play, measured"
```

---

### Task 7: The PR

- [ ] **Step 1: Full checks**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass, with only the known pre-existing `react-hooks/exhaustive-deps` warning.

- [ ] **Step 2: PR body**

Must contain:

- The **front-end exemption with its reason**, as `CLAUDE.md` requires: browser-only because the terminal has no `<video>` and the TUI already hands off to mpv/IINA/VLC, which demux MKV natively. Note that `src/util/ffmpegBin.ts` and `src/core/transcodeArgs.ts` sit below both front ends so a future TUI use does not have to move them.
- **What still does not play**: HEVC, AV1 and Dolby Vision video on any file the provider will not transcode. This is the deliberate gap from the spec, not an oversight.
- **That ffmpeg is optional**: absent, everything behaves exactly as it did before this change.
- The convergence measurement from Task 6.

---

## Self-review notes

- **Spec coverage.** Rung 3 → Tasks 2, 3, 4, 5. Binary discovery → consumed from the previous plan's `src/util/ffmpegBin.ts`, not reimplemented. Ladder ordering (provider above local, direct above both) → Task 5. Session teardown and the leaked-ffmpeg failure → Task 3's tests and Task 4 step 4. Capability auth on segments → Task 4, with the hls.js relative-URL trap called out in Task 5 step 4. Real-`http.Server` testing → Task 4. ffmpeg never executed in the suite → Task 3's injected `spawnImpl`. Docs and the exemption → Tasks 6 and 7.
- **One thing the spec did not settle, decided here.** Event playlist versus VOD playlist. The plan header states the trade-off, and Task 6 measures it rather than assuming — with an explicit instruction to file the VOD follow-up if the measurement is bad.
- **One refactor included because the work needs it.** Task 1 extracts `authorizeStreamFile`. Three route families needing the same four checks, with the codebase's own comment warning that a copy will skip the capability one, is the case for extracting rather than copying.
- **Naming consistency.** `authorizeStreamFile`, `canRemux`, `transcodeArgs`, `isSegmentName`, `HLS_PLAYLIST`, `HLS_INIT`, `TranscodeRegistry`, `acquire`/`touch`/`dirFor`/`reapIdle`/`release`/`releaseAll`, `isHlsPath`, `parseHlsPath`, `handleHlsRequest`, `hlsPlaylistPath`, `localHlsUrl`, `withCapability` — each defined once and referenced by that name everywhere after.
