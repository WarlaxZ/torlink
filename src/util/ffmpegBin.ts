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
  /** Rejects when the path is not there. Injected so tests need no such file. */
  accessImpl?: (path: string) => Promise<void>;
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
      const proc = spawn(probe!, args as string[], {
        windowsHide: true,
        shell: platform !== "win32",
      });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
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

function expandWinPath(
  template: string,
  bin: string,
  env: NodeJS.ProcessEnv,
): string | null {
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
// while the process is alive. A negative answer is cached too — a host with no
// ffmpeg is the case that would otherwise pay the lookup most often.
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
  const access = deps.accessImpl ?? ((p: string) => fs.access(p));

  let found: string | null = null;
  if (await which(bin)) {
    found = bin;
  } else if (platform === "win32") {
    for (const template of WIN_PATHS) {
      const candidate = expandWinPath(template, bin, env);
      if (!candidate) continue;
      try {
        await access(candidate);
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
