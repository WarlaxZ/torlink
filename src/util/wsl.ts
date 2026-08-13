import path from "node:path";

// WSL runs a Linux process — process.platform is "linux", not "win32" — but a
// file dragged from Windows Explorer onto the terminal arrives as a Windows
// path (C:\Users\…\a.torrent). That path is only reachable through the
// /mnt/<drive>/ interop mount, so a Linux fs call on the raw path fails. These
// two helpers let a caller detect WSL and translate such a path.

// True only for a Linux process with WSL's interop env set. Takes env so it is
// testable; defaults to the live environment. Mirrors the check in clipboard.ts,
// which imports this so the two never drift.
export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "linux" && !!env.WSL_DISTRO_NAME;
}

// C:\Users\u\a.torrent -> /mnt/c/Users/u/a.torrent. Accepts either slash so a
// file:// path already decoded to C:/… works too. Returns null for anything
// that isn't a drive-letter path (a POSIX path, a ~ path, a UNC \\share, a
// plain search query) so the caller can fall back to normal handling.
// mountRoot defaults to /mnt but is overridable for automount-root=/ setups.
export function wslPathFromWindows(input: string, mountRoot = "/mnt"): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(input.trim());
  if (!m) return null;
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\\/g, "/");
  return path.posix.join(mountRoot, drive, rest);
}
