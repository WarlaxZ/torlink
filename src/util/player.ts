import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

export interface StreamFile {
  url: string;
  filename: string;
  bytes: number;
}

// Extensions we treat as playable video, most-common first.
const VIDEO_EXTS = new Set([
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "webm",
  "ts",
  "m2ts",
  "flv",
  "wmv",
  "mpg",
  "mpeg",
]);

// Players we probe for, in preference order, when none is configured. Each has
// a CLI name (looked up on PATH) and, on macOS, an .app bundle name we can
// launch with `open -a` even when nothing is on PATH.
interface PlayerCandidate {
  cli: string;
  macApp?: string;
}

const PLAYER_CANDIDATES: PlayerCandidate[] = [
  { cli: "mpv" },
  { cli: "iina", macApp: "IINA" },
  { cli: "vlc", macApp: "VLC" },
];

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * Pick the file most worth streaming: the largest video file, or — if nothing
 * looks like video — the largest file overall. Returns null for an empty list.
 */
export function pickStreamFile(files: StreamFile[]): StreamFile | null {
  if (files.length === 0) return null;
  const videos = files.filter((f) => VIDEO_EXTS.has(ext(f.filename)));
  const pool = videos.length > 0 ? videos : files;
  return pool.reduce((best, f) => (f.bytes > best.bytes ? f : best), pool[0]!);
}

/**
 * The files worth offering for streaming: the video files if any exist,
 * otherwise every file. Used to decide whether to show a picker (2+ items) and
 * what to list. Mirrors pickStreamFile's video heuristic.
 */
export function streamCandidates(files: StreamFile[]): StreamFile[] {
  const videos = files.filter((f) => VIDEO_EXTS.has(ext(f.filename)));
  return videos.length > 0 ? videos : files;
}

export type WhichImpl = (cmd: string) => Promise<boolean>;

// Whether a command resolves on PATH. Uses the platform's lookup tool; never
// runs the player itself.
function commandExists(cmd: string): Promise<boolean> {
  const [probe, args] =
    process.platform === "win32" ? ["where", [cmd]] : ["command", ["-v", cmd]];
  return new Promise((resolve) => {
    try {
      const proc = spawn(probe, args, { windowsHide: true, shell: process.platform !== "win32" });
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

// Whether a macOS .app bundle of this name is installed.
async function macAppExists(app: string): Promise<boolean> {
  for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
    try {
      await fs.access(path.join(base, `${app}.app`));
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

export interface DetectDeps {
  which?: WhichImpl;
  appExists?: (app: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

/**
 * Find the first available player, or null. On macOS this also matches an
 * installed .app bundle (VLC, IINA) even when nothing is on PATH — common,
 * since GUI players usually aren't. Deps are injectable for testing.
 */
export async function detectPlayer(deps: DetectDeps = {}): Promise<string | null> {
  const which = deps.which ?? commandExists;
  const appExists = deps.appExists ?? macAppExists;
  const platform = deps.platform ?? process.platform;
  for (const c of PLAYER_CANDIDATES) {
    if (await which(c.cli)) return c.cli;
    if (platform === "darwin" && c.macApp && (await appExists(c.macApp))) return c.macApp;
  }
  return null;
}

// Spawn a player process directly (the player IS this process and keeps
// running). Resolves false on a spawn error (e.g. ENOENT), else true shortly
// after — we don't wait for the player to exit.
function spawnPlayer(command: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, [url], { detached: true, stdio: "ignore", windowsHide: true });
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      proc.on("error", () => done(false));
      proc.unref();
      const timer = setTimeout(() => done(true), 300);
      timer.unref?.();
    } catch {
      resolve(false);
    }
  });
}

// macOS: hand the URL to an app bundle via `open -a`. `open` returns promptly
// (it just launches the app), so we can wait for its exit code: non-zero means
// the app wasn't found.
function openWithApp(app: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn("open", ["-a", app, url], { stdio: "ignore", windowsHide: true });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Launch a media player on a URL. Tries the command directly first (a CLI on
 * PATH or an absolute path); on macOS, if that can't be spawned, falls back to
 * `open -a <command>` so a bare app name like "VLC" or "IINA" still works.
 * Resolves false only when neither route launches anything.
 */
export async function launchPlayer(command: string, url: string): Promise<boolean> {
  if (await spawnPlayer(command, url)) return true;
  if (process.platform === "darwin") return openWithApp(command, url);
  return false;
}
