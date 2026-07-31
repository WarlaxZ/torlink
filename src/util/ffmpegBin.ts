// Whether this host can transcode, and with which binary.
//
// ffmpeg is NOT a dependency of torlnk. It is detected, and its absence is a
// normal answer that costs the web player a rung on its source ladder and
// nothing else. Nothing here downloads or installs anything.
//
// Deliberately the same shape as PLAYER_CANDIDATES in ./player.ts: a CLI name
// on PATH, plus known Windows install paths, because on Windows a user who
// installed ffmpeg from a zip very often has it nowhere near PATH.
import fs from "node:fs/promises";
import path from "node:path";

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

/**
 * Whether a command resolves on PATH, by walking PATH ourselves.
 *
 * `src/util/player.ts` answers the same question by spawning `command -v` under
 * a shell. That is not copied here for two reasons: `spawn(cmd, args, { shell:
 * true })` is deprecated as of Node 22 and prints a warning on every lookup —
 * which for this module is once per player page load — and a PATH walk needs no
 * subprocess, no timeout, and no shell to quote things into.
 *
 * Never runs the binary itself: `ffmpeg` with no arguments prints a banner and
 * exits non-zero, which is not the question being asked.
 */
async function commandExists(
  cmd: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  access: (p: string) => Promise<void>,
): Promise<boolean> {
  const win = platform === "win32";
  // path.join follows the AMBIENT platform, but `platform` here is a parameter —
  // so joining with the default would build "C:\bin/ffprobe.exe" whenever the
  // two disagree. Picking the flavour explicitly is what makes the win32 branch
  // both correct and testable from anywhere.
  const join = win ? path.win32.join : path.posix.join;
  const dirs = (env.PATH ?? "").split(win ? ";" : ":").filter(Boolean);
  // On Windows a bare name is not executable; PATHEXT is the list of suffixes
  // the shell would have tried. Elsewhere the name stands alone.
  const suffixes = win ? (env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      try {
        await access(join(dir, `${cmd}${suffix}`));
        return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
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
  // X_OK, not mere existence: a non-executable file of the right name on PATH
  // is not a usable binary, and finding one would turn "no ffmpeg" into a spawn
  // that fails later and less clearly.
  const access = deps.accessImpl ?? ((p: string) => fs.access(p, fs.constants.X_OK));
  const which = deps.whichImpl ?? ((c: string) => commandExists(c, platform, env, access));

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
