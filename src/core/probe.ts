// Ask ffprobe what a URL actually contains.
//
// This is the accurate half of playback classification; ../util/playability.ts's
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

// Worst-first, matching normaliseAudioCodec's ordering in ../util/playability.ts
// for the same reason: a dual-audio file offers the browser a choice, and the
// track it cannot decode is the one that decides whether this plays.
const AUDIO_RANK = ["truehd", "dts", "eac3", "ac3", "flac", "opus", "vorbis", "aac", "mp3"];

function worstAudio(names: string[]): string {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  // ffprobe writing something that parses but is not the documented object is
  // not a case worth distinguishing from garbage: both mean "use the name".
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const streams = (parsed as { streams?: ProbeStream[] }).streams ?? [];
  if (!Array.isArray(streams)) return null;

  const video = streams.find((s) => s.codec_type === "video")?.codec_name ?? "";
  // No video stream means the probe never reached the media — a truncated
  // response, an error page, a range the CDN refused. The name is a better
  // answer than this.
  if (!video) return null;

  const audio = streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => (s.codec_name ?? "").toLowerCase())
    .filter(Boolean);
  const videoCodec = video.toLowerCase();
  return {
    container,
    // avc1 is the mp4 sample-entry name for the same thing h264 is; the rest of
    // the codebase only knows "h264".
    videoCodec: videoCodec === "avc1" ? "h264" : videoCodec,
    audioCodec: worstAudio(audio),
    source: "probe",
  };
}

export type RunProbe = (bin: string, args: string[]) => Promise<string>;

// Runs ffprobe with no shell and a hard timeout, and rejects on a non-zero exit
// so the caller's catch is the single failure path.
const runProbe: RunProbe = (bin, args) =>
  new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
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
